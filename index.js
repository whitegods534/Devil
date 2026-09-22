import express from "express";
import axios from "axios";
import pg from "pg";

import {
    Client,
    GatewayIntentBits,
    Partials,
    PermissionFlagsBits,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    SlashCommandBuilder
} from "discord.js";

const { Pool } = pg;

/* =========================================================
   CONFIG
========================================================= */

const TOKEN = process.env.DISCORD_TOKEN;
const API_SECRET = process.env.API_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const PORT = process.env.PORT || 8080;

const BADGE_ID = "1761374138287057";

const SUPPORT_ROLE_ID = "1548329037884297229";
const MANAGER_ROLE_ID = "1550551297642729552";
const FINANCIAL_OPERATIONS_ROLE_ID = "1551601783581843497";

const LEADERBOARD_CHANNEL_ID = "1551976849385586759";
const FEEDBACK_CHANNEL_ID = "1551996605719380128";

const pendingFeedback = new Map();
const pendingClose = new Map();

if (!TOKEN) {
    console.error("Missing DISCORD_TOKEN");
    process.exit(1);
}

if (!API_SECRET) {
    console.error("Missing API_SECRET");
    process.exit(1);
}

if (!DATABASE_URL) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
}

/* =========================================================
   COLORS
========================================================= */

const COLORS = {
    blue: 0x3498db,
    purple: 0x9b59b6,
    green: 0x2ecc71,
    red: 0xe74c3c,
    orange: 0xe67e22,
    pink: 0xff69b4,
    cyan: 0x00ffff,
    dark: 0x2f3136
};

function getColor(name, fallback = "blue") {
    return COLORS[name] || COLORS[fallback];
}

/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function query(text, params = []) {
    return pool.query(text, params);
}

async function setupDatabase() {

    await query(`
        CREATE TABLE IF NOT EXISTS authorizations (
            id SERIAL PRIMARY KEY,
            roblox_username TEXT NOT NULL,
            roblox_user_id BIGINT UNIQUE NOT NULL,
            discord_user_id TEXT NOT NULL,
            authorized BOOLEAN NOT NULL DEFAULT TRUE,
            authorization_source TEXT NOT NULL DEFAULT 'manual',
            authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            authorized_by TEXT NOT NULL,
            rban BOOLEAN NOT NULL DEFAULT FALSE,
            rban_at TIMESTAMPTZ,
            rban_by TEXT
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS authorization_history (
            id SERIAL PRIMARY KEY,
            roblox_username TEXT NOT NULL,
            roblox_user_id BIGINT NOT NULL,
            action TEXT NOT NULL,
            source TEXT,
            staff_user_id TEXT,
            staff_tag TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS ticket_config (
            guild_id TEXT PRIMARY KEY,
            support_role_id TEXT NOT NULL,
            management_role_id TEXT NOT NULL,
            category_id TEXT NOT NULL,
            log_channel_id TEXT,
            panel_channel_id TEXT,
            panel_message_id TEXT,
            panel_color TEXT NOT NULL DEFAULT 'blue',
            ticket_color TEXT NOT NULL DEFAULT 'blue',
            success_color TEXT NOT NULL DEFAULT 'green',
            error_color TEXT NOT NULL DEFAULT 'red',
            leaderboard_color TEXT NOT NULL DEFAULT 'purple',
            leaderboard_message_id TEXT
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS tickets (
            channel_id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            opener_id TEXT NOT NULL,
            opener_tag TEXT,
            claimer_id TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            claimed_at TIMESTAMPTZ,
            closed_at TIMESTAMPTZ,
            escalated_by TEXT,
            escalated_at TIMESTAMPTZ
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS ticket_claims (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            user_tag TEXT,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS ticket_join_requests (
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            user_tag TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (channel_id, user_id)
        )
    `);

    await query(`
        ALTER TABLE ticket_join_requests
        ADD COLUMN IF NOT EXISTS reason TEXT
    `);

    await query(`
        ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS escalated_by TEXT
    `);

    await query(`
        ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ
    `);

    console.log("[DATABASE] Ready");
}

/* =========================================================
   DISCORD CLIENT
========================================================= */

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [
        Partials.Channel,
        Partials.Message
    ]
});

/* =========================================================
   PERMISSION HELPERS
========================================================= */

function hasRole(member, roleId) {
    return Boolean(
        member?.roles?.cache?.has(roleId)
    );
}

function isSupport(member, config = null) {
    return hasRole(
        member,
        config?.support_role_id || SUPPORT_ROLE_ID
    );
}

async function getTicketConfig(guildId) {

    const result = await query(
        `
        SELECT *
        FROM ticket_config
        WHERE guild_id = $1
        `,
        [guildId]
    );

    return result.rows[0] || null;
}

function isManagement(member, config) {

    if (!config) {
        return false;
    }

    return hasRole(
        member,
        config.management_role_id
    );
}

function isFinancialOperations(member) {
    return hasRole(
        member,
        FINANCIAL_OPERATIONS_ROLE_ID
    );
}

function canManageTickets(member, config) {
    return (
        isSupport(member, config) ||
        isManagement(member, config)
    );
}

/* =========================================================
   ROBLOX HELPERS
========================================================= */

async function getRobloxUser(username) {

    try {

        const response = await axios.post(
            "https://users.roblox.com/v1/usernames/users",
            {
                usernames: [username],
                excludeBannedUsers: false
            }
        );

        if (!response.data?.data?.length) {
            return null;
        }

        return response.data.data[0];

    } catch (error) {

        console.error(
            "[ROBLOX USER ERROR]",
            error.message
        );

        return null;
    }
}

async function getRobloxProfile(userId) {

    try {

        const response = await axios.get(
            `https://users.roblox.com/v1/users/${userId}`
        );

        return response.data;

    } catch {

        return null;
    }
}

async function getRobloxAvatar(userId) {

    try {

        const response = await axios.get(
            "https://thumbnails.roblox.com/v1/users/avatar-headshot",
            {
                params: {
                    userIds: userId,
                    size: "420x420",
                    format: "Png",
                    isCircular: false
                }
            }
        );

        return (
            response.data?.data?.[0]?.imageUrl ||
            null
        );

    } catch {

        return null;
    }
}

async function getRobloxFollowers(userId) {

    try {

        const followers = await axios.get(
            `https://friends.roblox.com/v1/users/${userId}/followers/count`
        );

        const following = await axios.get(
            `https://friends.roblox.com/v1/users/${userId}/followings/count`
        );

        return {
            followers: followers.data?.count ?? 0,
            following: following.data?.count ?? 0
        };

    } catch {

        return {
            followers: 0,
            following: 0
        };
    }
}

/* =========================================================
   AUTHORIZATION
========================================================= */

async function saveAuthorization({
    robloxUsername,
    robloxUserId,
    discordUserId,
    source,
    authorizedBy,
    authorized = true
}) {

    const existing = await query(
        `
        SELECT rban
        FROM authorizations
        WHERE roblox_user_id = $1
        `,
        [robloxUserId]
    );

    if (existing.rows[0]?.rban) {

        return {
            success: false,
            reason: "rban"
        };
    }

    await query(
        `
        INSERT INTO authorizations (
            roblox_username,
            roblox_user_id,
            discord_user_id,
            authorized,
            authorization_source,
            authorized_at,
            authorized_by
        )
        VALUES ($1,$2,$3,$4,$5,NOW(),$6)

        ON CONFLICT (roblox_user_id)

        DO UPDATE SET
            roblox_username = EXCLUDED.roblox_username,
            discord_user_id = EXCLUDED.discord_user_id,
            authorized = EXCLUDED.authorized,
            authorization_source = EXCLUDED.authorization_source,
            authorized_at = NOW(),
            authorized_by = EXCLUDED.authorized_by
        `,
        [
            robloxUsername,
            robloxUserId,
            discordUserId,
            authorized,
            source,
            authorizedBy
        ]
    );

    await query(
        `
        INSERT INTO authorization_history (
            roblox_username,
            roblox_user_id,
            action,
            source,
            staff_user_id,
            staff_tag
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [
            robloxUsername,
            robloxUserId,
            authorized
                ? "authorized"
                : "unauthorized",
            source,
            authorizedBy,
            authorizedBy
        ]
    );

    return {
        success: true
    };
}

/* =========================================================
   EMBEDS
========================================================= */

function successEmbed(
    title,
    description,
    color = "green"
) {

    return new EmbedBuilder()
        .setTitle(`✅ ${title}`)
        .setDescription(description)
        .setColor(getColor(color))
        .setTimestamp();
}

function errorEmbed(
    title,
    description,
    color = "red"
) {

    return new EmbedBuilder()
        .setTitle(`❌ ${title}`)
        .setDescription(description)
        .setColor(getColor(color))
        .setTimestamp();
}

function ticketEmbed(
    config,
    ticket,
    opener
) {

    const color =
        config?.ticket_color || "blue";

    const embed = new EmbedBuilder()
        .setTitle("🎫 Support Ticket")
        .setDescription(
            ticket.status === "claimed"
                ? "This ticket has been claimed. Only the client and assigned staff can speak unless another staff member is approved through **Request to Join**."
                : "A member of Support will assist you shortly."
        )
        .addFields(
            {
                name: "Status",
                value:
                    ticket.status === "claimed"
                        ? "🟢 Claimed"
                        : ticket.status === "escalated"
                            ? "🟠 Escalated"
                            : "🟡 Open",
                inline: true
            },
            {
                name: "Opened By",
                value: `<@${ticket.opener_id}>`,
                inline: true
            },
            {
                name: "Claimed By",
                value: ticket.claimer_id
                    ? `<@${ticket.claimer_id}>`
                    : "Unclaimed",
                inline: true
            }
        )
        .setColor(getColor(color))
        .setFooter({
            text: "Devil Support"
        })
        .setTimestamp();

    if (ticket.status === "escalated") {

        embed.addFields({
            name: "Escalated To",
            value: `<@&${MANAGER_ROLE_ID}>`,
            inline: true
        });
    }

    if (opener?.displayAvatarURL) {
        embed.setThumbnail(
            opener.displayAvatarURL()
        );
    }

    return embed;
}

/* =========================================================
   TICKET BUTTONS
========================================================= */

function ticketButtons() {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId("ticket_claim")
                .setLabel("Claim")
                .setEmoji("📌")
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId("ticket_escalate")
                .setLabel("Escalate")
                .setEmoji("⚠️")
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId("ticket_close")
                .setLabel("Close")
                .setEmoji("🔒")
                .setStyle(ButtonStyle.Danger)
        );
}

function ticketClaimedButtons() {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId("ticket_join_request")
                .setLabel("Request to Join")
                .setEmoji("👥")
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId("ticket_unclaim")
                .setLabel("Unclaim")
                .setEmoji("↩️")
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId("ticket_escalate")
                .setLabel("Escalate")
                .setEmoji("⚠️")
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId("ticket_close")
                .setLabel("Close")
                .setEmoji("🔒")
                .setStyle(ButtonStyle.Danger)
        );
}

/* =========================================================
   JOIN REQUEST MODAL
========================================================= */

function joinRequestModal() {

    const modal = new ModalBuilder()
        .setCustomId("ticket_join_reason")
        .setTitle("Request to Join Ticket");

    const reason = new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Why should you be accepted?")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder(
            "Explain why you need to join this ticket..."
        )
        .setMinLength(5)
        .setMaxLength(500)
        .setRequired(true);

    modal.addComponents(
        new ActionRowBuilder()
            .addComponents(reason)
    );

    return modal;
}

/* =========================================================
   JOIN REQUEST APPROVE / DENY BUTTONS
========================================================= */

function joinRequestButtons(
    userId,
    joined = 0
) {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `ticket_join_approve:${userId}`
                )
                .setLabel(
                    `Accept (${joined}/1)`
                )
                .setEmoji("✅")
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId(
                    `ticket_join_deny:${userId}`
                )
                .setLabel("Deny")
                .setEmoji("❌")
                .setStyle(ButtonStyle.Danger)
        );
}

/* =========================================================
   FEEDBACK BUTTONS
========================================================= */

function closeChoiceButtons() {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId(
                    "feedback_close_yes"
                )
                .setLabel("Yes, close it")
                .setEmoji("🔒")
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId(
                    "feedback_close_no"
                )
                .setLabel("No, keep it open")
                .setEmoji("↩️")
                .setStyle(ButtonStyle.Secondary)
        );
}

/* =========================================================
   TICKET FEEDBACK
========================================================= */

async function requestTicketFeedback(
    guild,
    channel,
    ticket
) {

    if (
        !ticket?.opener_id ||
        !ticket?.claimer_id
    ) {

        setTimeout(
            async () => {
                await channel.delete()
                    .catch(() => {});
            },
            10 * 60 * 1000
        );

        return;
    }

    try {

        const clientUser =
            await client.users.fetch(
                ticket.opener_id
            );

        const staffUser =
            await client.users.fetch(
                ticket.claimer_id
            );

        const dm =
            await clientUser.createDM();

        await dm.send({

            embeds: [

                new EmbedBuilder()
                    .setTitle("🎫 Ticket Feedback")
                    .setDescription(
                        `Please could you give ${staffUser} feedback on how they handled this ticket?\n\n` +
                        "Simply send your feedback as your next message.\n\n" +
                        "You have 10 minutes to send your feedback."
                    )
                    .setColor(
                        getColor("purple")
                    )
                    .setTimestamp()
            ]
        });

        const timeout = setTimeout(
            async () => {

                const pending =
                    pendingFeedback.get(
                        clientUser.id
                    );

                if (
                    !pending ||
                    pending.channelId !==
                        channel.id
                ) {
                    return;
                }

                pendingFeedback.delete(
                    clientUser.id
                );

                await channel.delete()
                    .catch(() => {});

            },
            10 * 60 * 1000
        );

        pendingFeedback.set(
            clientUser.id,
            {
                channelId: channel.id,
                guildId: guild.id,
                staffId: staffUser.id,
                staffTag: staffUser.tag,
                timeout
            }
        );

    } catch (error) {

        console.error(
            "[FEEDBACK REQUEST ERROR]",
            error.message
        );

        setTimeout(
            async () => {
                await channel.delete()
                    .catch(() => {});
            },
            10 * 60 * 1000
        );
    }
}

async function sendFeedbackToStaff(
    message,
    feedback
) {

    const feedbackChannel =
        await client.channels.fetch(
            FEEDBACK_CHANNEL_ID
        ).catch(() => null);

    const embed =
        new EmbedBuilder()
            .setTitle("⭐ New Ticket Feedback")
            .setDescription(
                `**Client:** ${message.author}\n` +
                `**Staff Member:** <@${feedback.staffId}>\n\n` +
                `**Feedback:**\n${message.content}`
            )
            .setColor(
                getColor("green")
            )
            .setTimestamp();

    if (feedbackChannel) {

        await feedbackChannel.send({
            content:
                `<@${feedback.staffId}>`,
            embeds: [embed]
        }).catch(() => {});
    }

    const staffUser =
        await client.users.fetch(
            feedback.staffId
        ).catch(() => null);

    if (staffUser) {

        await staffUser.send({
            embeds: [embed]
        }).catch(() => {});
    }
}

async function finishTicketClose(
    channel,
    userId = null
) {

    if (userId) {

        const pending =
            pendingClose.get(userId);

        if (pending?.timeout) {
            clearTimeout(
                pending.timeout
            );
        }

        pendingClose.delete(userId);
        pendingFeedback.delete(userId);
    }

    await channel.delete()
        .catch(() => {});
}

/* =========================================================
   LOGGING
========================================================= */

async function logTicket(
    guild,
    config,
    title,
    description,
    color = "blue"
) {

    if (!config?.log_channel_id) {
        return;
    }

    const channel =
        guild.channels.cache.get(
            config.log_channel_id
        );

    if (!channel) {
        return;
    }

    const embed =
        new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(getColor(color))
            .setTimestamp();

    await channel.send({
        embeds: [embed]
    }).catch(() => {});
}

/* =========================================================
   CLAIM STATISTICS
========================================================= */

async function addClaim(
    guildId,
    userId,
    userTag
) {

    await query(
        `
        INSERT INTO ticket_claims (
            guild_id,
            user_id,
            user_tag,
            count
        )
        VALUES ($1,$2,$3,1)

        ON CONFLICT (guild_id,user_id)

        DO UPDATE SET
            count = ticket_claims.count + 1,
            user_tag = EXCLUDED.user_tag
        `,
        [
            guildId,
            userId,
            userTag
        ]
    );
}

async function wipeClaims(
    guildId,
    userId
) {

    await query(
        `
        DELETE FROM ticket_claims
        WHERE guild_id = $1
        AND user_id = $2
        `,
        [
            guildId,
            userId
        ]
    );
}

/* =========================================================
   LEADERBOARD
========================================================= */

async function updateLeaderboard(guild) {

    const config =
        await getTicketConfig(
            guild.id
        );

    if (!config) {
        return;
    }

    const channel =
        guild.channels.cache.get(
            LEADERBOARD_CHANNEL_ID
        );

    if (!channel) {
        return;
    }

    const result =
        await query(
            `
            SELECT user_id, user_tag, count
            FROM ticket_claims
            WHERE guild_id = $1
            ORDER BY count DESC
            LIMIT 10
            `,
            [guild.id]
        );

    const rows = result.rows;

    let description = "";

    if (!rows.length) {

        description =
            "No ticket claims have been recorded yet.";

    } else {

        description =
            rows
                .map((row, index) => {

                    const position =
                        index + 1;

                    let medal =
                        `${position}.`;

                    if (position === 1) {
                        medal = "🥇";
                    }

                    if (position === 2) {
                        medal = "🥈";
                    }

                    if (position === 3) {
                        medal = "🥉";
                    }

                    return (
                        `${medal} <@${row.user_id}> — ` +
                        `**${row.count} claims**`
                    );

                })
                .join("\n");
    }

    const embed =
        new EmbedBuilder()
            .setTitle(
                "🏆 Ticket Leaderboard"
            )
            .setDescription(
                description
            )
            .addFields({
                name: "Updates",
                value:
                    "Automatically updated every 30 minutes.",
                inline: false
            })
            .setColor(
                getColor(
                    config.leaderboard_color ||
                    "purple"
                )
            )
            .setFooter({
                text: "Devil Support"
            })
            .setTimestamp();

    let message = null;

    if (
        config.leaderboard_message_id
    ) {

        message =
            await channel.messages.fetch(
                config.leaderboard_message_id
            ).catch(() => null);
    }

    if (message) {

        await message.edit({
            embeds: [embed]
        }).catch(() => {});

        return;
    }

    message =
        await channel.send({
            embeds: [embed]
        }).catch(() => null);

    if (!message) {
        return;
    }

    await query(
        `
        UPDATE ticket_config
        SET leaderboard_message_id = $1
        WHERE guild_id = $2
        `,
        [
            message.id,
            guild.id
        ]
    );
}

/* =========================================================
   LEADERBOARD TIMER
========================================================= */

setInterval(
    async () => {

        for (
            const guild of
            client.guilds.cache.values()
        ) {

            await updateLeaderboard(
                guild
            ).catch(() => {});
        }

    },
    30 * 60 * 1000
);

/* =========================================================
   READY
========================================================= */

client.once(
    "clientReady",
    async () => {

        console.log(
            `[DISCORD] Logged in as ${client.user.tag}`
        );

        try {

            await setupDatabase();

            for (
                const guild of
                client.guilds.cache.values()
            ) {

                await updateLeaderboard(
                    guild
                ).catch(() => {});
            }

        } catch (error) {

            console.error(
                "[READY ERROR]",
                error
            );
        }
    }
);

/* =========================================================
   INTERACTIONS
========================================================= */

client.on(
    "interactionCreate",
    async interaction => {

        try {

            /* ============================================
               JOIN REQUEST MODAL
            ============================================ */

            if (
                interaction.isModalSubmit() &&
                interaction.customId ===
                    "ticket_join_reason"
            ) {

                const guild =
                    interaction.guild;

                if (!guild) {
                    return;
                }

                const config =
                    await getTicketConfig(
                        guild.id
                    );

                if (!config) {

                    return interaction.reply({
                        content:
                            "Ticket system is not configured.",
                        ephemeral: true
                    });
                }

                const ticketResult =
                    await query(
                        `
                        SELECT *
                        FROM tickets
                        WHERE channel_id = $1
                        `,
                        [interaction.channel.id]
                    );

                const ticket =
                    ticketResult.rows[0];

                if (
                    !ticket ||
                    ticket.status === "closed"
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Not A Ticket",
                                "This ticket is closed or no longer exists."
                            )
                        ],
                        ephemeral: true
                    });
                }

                if (!ticket.claimer_id) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Unclaimed",
                                "This ticket is not currently claimed."
                            )
                        ],
                        ephemeral: true
                    });
                }

                if (
                    !isSupport(
                        interaction.member,
                        config
                    ) &&
                    !isManagement(
                        interaction.member,
                        config
                    )
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "No Permission",
                                "Only Support or Management can request to join a claimed ticket."
                            )
                        ],
                        ephemeral: true
                    });
                }

                if (
                    ticket.claimer_id ===
                    interaction.user.id
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Already Joined",
                                "You already have access to this ticket."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const joinedResult =
                    await query(
                        `
                        SELECT COUNT(*)::int AS count
                        FROM ticket_join_requests
                        WHERE channel_id = $1
                        AND status = 'approved'
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                const joined =
                    joinedResult.rows[0]?.count ||
                    0;

                if (joined >= 1) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Join Limit Reached",
                                "This ticket already has 1 additional staff member joined (1/1)."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const reason =
                    interaction.fields
                        .getTextInputValue(
                            "reason"
                        )
                        .trim();

                await query(
                    `
                    INSERT INTO ticket_join_requests (
                        channel_id,
                        user_id,
                        user_tag,
                        status,
                        reason
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        'pending',
                        $4
                    )

                    ON CONFLICT (
                        channel_id,
                        user_id
                    )

                    DO UPDATE SET
                        status = 'pending',
                        user_tag = EXCLUDED.user_tag,
                        reason = EXCLUDED.reason,
                        created_at = NOW()
                    `,
                    [
                        interaction.channel.id,
                        interaction.user.id,
                        interaction.user.tag,
                        reason
                    ]
                );

                const requestEmbed =
                    new EmbedBuilder()
                        .setTitle(
                            "👥 Request to Join"
                        )
                        .setDescription(
                            `${interaction.user} would like to join the ticket.\n\n` +
                            `**Reason:**\n${reason}\n\n` +
                            `**Joined:** ${joined}/1 joined so far`
                        )
                        .setColor(
                            getColor("purple")
                        )
                        .setTimestamp();

                await interaction.reply({

                    content:
                        `<@${ticket.claimer_id}>`,

                    embeds: [
                        requestEmbed
                    ],

                    components: [
                        joinRequestButtons(
                            interaction.user.id,
                            joined
                        )
                    ]
                });

                return;
            }

            /* ============================================
               BUTTONS
            ============================================ */

            if (
                interaction.isButton()
            ) {

                if (
                    interaction.customId ===
                    "ticket_create"
                ) {
                    return;
                }

                const guild =
                    interaction.guild;

                if (!guild) {
                    return;
                }

                const config =
                    await getTicketConfig(
                        guild.id
                    );

                if (!config) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Not Configured",
                                "The ticket system has not been configured."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const ticketResult =
                    await query(
                        `
                        SELECT *
                        FROM tickets
                        WHERE channel_id = $1
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                const ticket =
                    ticketResult.rows[0];

                if (!ticket) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Not A Ticket",
                                "This channel is not a ticket."
                            )
                        ],
                        ephemeral: true
                    });
                }

                /* ========================================
                   CLAIM
                ======================================== */

                if (
                    interaction.customId ===
                    "ticket_claim"
                ) {

                    if (
                        !canManageTickets(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "You need Support or Management to claim tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        ticket.status ===
                        "closed"
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Closed",
                                    "This ticket is already closed."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        ticket.claimer_id ===
                        interaction.user.id
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Already Claimed",
                                    "You already claimed this ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        ticket.claimer_id
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Already Claimed",
                                    `This ticket is already claimed by <@${ticket.claimer_id}>.`
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await query(
                        `
                        UPDATE tickets
                        SET
                            claimer_id = $1,
                            claimed_at = NOW(),
                            status = 'claimed'
                        WHERE channel_id = $2
                        `,
                        [
                            interaction.user.id,
                            interaction.channel.id
                        ]
                    );

                    await addClaim(
                        guild.id,
                        interaction.user.id,
                        interaction.user.tag
                    );

                    /*
                       Every old join request is removed when
                       a new staff member claims the ticket.
                    */

                    await query(
                        `
                        DELETE FROM ticket_join_requests
                        WHERE channel_id = $1
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                    /*
                       Disable speaking for the general
                       Support and Management roles.
                    */

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            config.support_role_id,
                            {
                                SendMessages: false,
                                AddReactions: false
                            }
                        )
                        .catch(() => {});

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            config.management_role_id,
                            {
                                SendMessages: false,
                                AddReactions: false
                            }
                        )
                        .catch(() => {});

                    /*
                       The claimant can still speak.
                    */

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            interaction.user.id,
                            {
                                ViewChannel: true,
                                SendMessages: true,
                                ReadMessageHistory: true,
                                AddReactions: true,
                                AttachFiles: true,
                                EmbedLinks: true
                            }
                        )
                        .catch(() => {});

                    /*
                       Lock explicitly-added staff members
                       so only the client and claimant can
                       talk until a join request is approved.
                    */

                    for (
                        const overwrite of
                        interaction.channel
                            .permissionOverwrites
                            .cache
                            .values()
                    ) {

                        if (
                            overwrite.type !== 1
                        ) {
                            continue;
                        }

                        if (
                            overwrite.id ===
                                ticket.opener_id ||
                            overwrite.id ===
                                interaction.user.id
                        ) {
                            continue;
                        }

                        await interaction.channel
                            .permissionOverwrites
                            .edit(
                                overwrite.id,
                                {
                                    SendMessages: false,
                                    AddReactions: false
                                }
                            )
                            .catch(() => {});
                    }

                    await interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket Claimed",
                                `${interaction.user} has claimed this ticket.`,
                                config.success_color
                            )
                        ]
                    });

                    await logTicket(
                        guild,
                        config,
                        "Ticket Claimed",
                        `${interaction.user} claimed ${interaction.channel}.`,
                        config.success_color
                    );

                    await updateLeaderboard(
                        guild
                    );

                    const claimedMessages =
                        await interaction.channel
                            .messages
                            .fetch({
                                limit: 10
                            })
                            .catch(() => null);

                    if (claimedMessages) {

                        const ticketMessage =
                            claimedMessages.find(
                                message =>
                                    message.author.id ===
                                        client.user.id &&
                                    message.embeds?.[0]
                                        ?.title ===
                                        "🎫 Support Ticket"
                            );

                        if (ticketMessage) {

                            const updatedTicket = {
                                ...ticket,
                                claimer_id:
                                    interaction.user.id,
                                status: "claimed"
                            };

                            await ticketMessage
                                .edit({
                                    embeds: [
                                        ticketEmbed(
                                            config,
                                            updatedTicket,
                                            interaction.guild
                                                .members
                                                .cache
                                                .get(
                                                    ticket.opener_id
                                                )
                                        )
                                    ],
                                    components: [
                                        ticketClaimedButtons()
                                    ]
                                })
                                .catch(() => {});
                        }
                    }

                    return;
                }

                /* ========================================
                   UNCLAIM
                ======================================== */

                if (
                    interaction.customId ===
                    "ticket_unclaim"
                ) {

                    if (
                        !canManageTickets(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "You need Support or Management to unclaim tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        ticket.claimer_id !==
                            interaction.user.id &&
                        !isManagement(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Not Your Ticket",
                                    "Only the claimed staff member or Management can unclaim this ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await query(
                        `
                        UPDATE tickets
                        SET
                            claimer_id = NULL,
                            claimed_at = NULL,
                            status = 'open'
                        WHERE channel_id = $1
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                    await query(
                        `
                        DELETE FROM ticket_join_requests
                        WHERE channel_id = $1
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            config.support_role_id,
                            {
                                ViewChannel: true,
                                SendMessages: true,
                                ReadMessageHistory: true,
                                AddReactions: true
                            }
                        )
                        .catch(() => {});

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            config.management_role_id,
                            {
                                ViewChannel: true,
                                SendMessages: true,
                                ReadMessageHistory: true,
                                AddReactions: true
                            }
                        )
                        .catch(() => {});

                    await interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket Unclaimed",
                                `${interaction.user} unclaimed this ticket. Staff can now respond again.`,
                                config.success_color
                            )
                        ]
                    });

                    const messages =
                        await interaction.channel
                            .messages
                            .fetch({
                                limit: 10
                            })
                            .catch(() => null);

                    if (messages) {

                        const ticketMessage =
                            messages.find(
                                message =>
                                    message.author.id ===
                                        client.user.id &&
                                    message.embeds?.[0]
                                        ?.title ===
                                        "🎫 Support Ticket"
                            );

                        if (ticketMessage) {

                            const updatedTicket = {
                                ...ticket,
                                claimer_id: null,
                                status: "open"
                            };

                            await ticketMessage
                                .edit({
                                    embeds: [
                                        ticketEmbed(
                                            config,
                                            updatedTicket,
                                            interaction.guild
                                                .members
                                                .cache
                                                .get(
                                                    ticket.opener_id
                                                )
                                        )
                                    ],
                                    components: [
                                        ticketButtons()
                                    ]
                                })
                                .catch(() => {});
                        }
                    }

                    return;
                }

                /* ========================================
                   REQUEST TO JOIN BUTTON
                ======================================== */

                if (
                    interaction.customId ===
                    "ticket_join_request"
                ) {

                    if (
                        !isSupport(
                            interaction.member,
                            config
                        ) &&
                        !isManagement(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "Only Support or Management can request to join a claimed ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (!ticket.claimer_id) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Unclaimed",
                                    "This ticket is not currently claimed."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        ticket.claimer_id ===
                        interaction.user.id
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Already Joined",
                                    "You already have access to this ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const joinedResult =
                        await query(
                            `
                            SELECT COUNT(*)::int AS count
                            FROM ticket_join_requests
                            WHERE channel_id = $1
                            AND status = 'approved'
                            `,
                            [
                                interaction.channel.id
                            ]
                        );

                    const joined =
                        joinedResult.rows[0]?.count ||
                        0;

                    if (joined >= 1) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Join Limit Reached",
                                    "This ticket already has 1 additional staff member joined (1/1)."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const existing =
                        await query(
                            `
                            SELECT status
                            FROM ticket_join_requests
                            WHERE channel_id = $1
                            AND user_id = $2
                            `,
                            [
                                interaction.channel.id,
                                interaction.user.id
                            ]
                        );

                    if (
                        existing.rows[0]
                            ?.status ===
                        "approved"
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Already Joined",
                                    "You already have access to this ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    /*
                       Open the modal asking why they
                       should be allowed into the ticket.
                    */

                    return interaction.showModal(
                        joinRequestModal()
                    );
                }

                /* ========================================
                   ACCEPT / DENY JOIN REQUEST
                ======================================== */

                if (
                    interaction.customId
                        .startsWith(
                            "ticket_join_approve:"
                        ) ||
                    interaction.customId
                        .startsWith(
                            "ticket_join_deny:"
                        )
                ) {

                    /*
                       ONLY the claimant or Management
                       can accept or deny.
                    */

                    if (
                        interaction.user.id !==
                            ticket.claimer_id &&
                        !isManagement(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "Only the claimed staff member or Management can handle join requests."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const requestedUserId =
                        interaction.customId
                            .split(":")[1];

                    const approve =
                        interaction.customId
                            .startsWith(
                                "ticket_join_approve:"
                            );

                    const requestedUser =
                        await client.users.fetch(
                            requestedUserId
                        ).catch(() => null);

                    if (!requestedUser) {

                        return interaction.reply({
                            content:
                                "User not found.",
                            ephemeral: true
                        });
                    }

                    if (approve) {

                        const joinedResult =
                            await query(
                                `
                                SELECT COUNT(*)::int AS count
                                FROM ticket_join_requests
                                WHERE channel_id = $1
                                AND status = 'approved'
                                `,
                                [
                                    interaction.channel.id
                                ]
                            );

                        const joined =
                            joinedResult.rows[0]
                                ?.count || 0;

                        if (joined >= 1) {

                            return interaction.reply({
                                embeds: [
                                    errorEmbed(
                                        "Join Limit Reached",
                                        "This ticket already has 1 additional staff member joined (1/1)."
                                    )
                                ],
                                ephemeral: true
                            });
                        }

                        await interaction.channel
                            .permissionOverwrites
                            .edit(
                                requestedUserId,
                                {
                                    ViewChannel: true,
                                    SendMessages: true,
                                    ReadMessageHistory: true,
                                    AttachFiles: true,
                                    EmbedLinks: true,
                                    AddReactions: true
                                }
                            )
                            .catch(() => {});

                        await query(
                            `
                            UPDATE ticket_join_requests
                            SET status = 'approved'
                            WHERE channel_id = $1
                            AND user_id = $2
                            `,
                            [
                                interaction.channel.id,
                                requestedUserId
                            ]
                        );

                        const newCount =
                            joined + 1;

                        const approvedEmbed =
                            interaction.message
                                .embeds[0]
                                ? EmbedBuilder.from(
                                    interaction.message
                                        .embeds[0]
                                )
                                : new EmbedBuilder();

                        approvedEmbed
                            .setColor(
                                getColor("green")
                            )
                            .setFooter({
                                text:
                                    `${newCount}/1 joined so far`
                            });

                        await interaction.update({

                            content:
                                `✅ ${requestedUser} has been approved to join this ticket.\n\n` +
                                `**${newCount}/1 joined so far**`,

                            embeds: [
                                approvedEmbed
                            ],

                            components: []
                        });

                    } else {

                        await query(
                            `
                            UPDATE ticket_join_requests
                            SET status = 'denied'
                            WHERE channel_id = $1
                            AND user_id = $2
                            `,
                            [
                                interaction.channel.id,
                                requestedUserId
                            ]
                        );

                        const joinedResult =
                            await query(
                                `
                                SELECT COUNT(*)::int AS count
                                FROM ticket_join_requests
                                WHERE channel_id = $1
                                AND status = 'approved'
                                `,
                                [
                                    interaction.channel.id
                                ]
                            );

                        const joined =
                            joinedResult.rows[0]
                                ?.count || 0;

                        const deniedEmbed =
                            interaction.message
                                .embeds[0]
                                ? EmbedBuilder.from(
                                    interaction.message
                                        .embeds[0]
                                )
                                : new EmbedBuilder();

                        deniedEmbed
                            .setColor(
                                getColor("red")
                            )
                            .setFooter({
                                text:
                                    `${joined}/1 joined so far`
                            });

                        await interaction.update({

                            content:
                                `❌ ${requestedUser}'s request to join was denied.\n\n` +
                                `**${joined}/1 joined so far**`,

                            embeds: [
                                deniedEmbed
                            ],

                            components: []
                        });
                    }

                    return;
                }

                /* ========================================
                   ESCALATE
                ======================================== */

                if (
                    interaction.customId ===
                    "ticket_escalate"
                ) {

                    if (
                        !canManageTickets(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "You need Support or Management to escalate tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await query(
                        `
                        UPDATE tickets
                        SET
                            status = 'escalated',
                            escalated_by = $1,
                            escalated_at = NOW()
                        WHERE channel_id = $2
                        `,
                        [
                            interaction.user.id,
                            interaction.channel.id
                        ]
                    );

                    await interaction.reply({

                        content:
                            `<@&${MANAGER_ROLE_ID}>`,

                        embeds: [

                            new EmbedBuilder()
                                .setTitle(
                                    "⚠️ Ticket Escalated"
                                )
                                .setDescription(
                                    `${interaction.user} has escalated this ticket to the Moderator team.`
                                )
                                .setColor(
                                    getColor("orange")
                                )
                                .setTimestamp()
                        ]
                    });

                    await logTicket(
                        guild,
                        config,
                        "Ticket Escalated",
                        `${interaction.user} escalated ${interaction.channel} to <@&${MANAGER_ROLE_ID}>.`,
                        "orange"
                    );

                    return;
                }

                /* ========================================
                   CLOSE
                ======================================== */

                if (
                    interaction.customId ===
                    "ticket_close"
                ) {

                    if (
                        !canManageTickets(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "You need Support or Management to close tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await query(
                        `
                        UPDATE tickets
                        SET
                            status = 'closed',
                            closed_at = NOW()
                        WHERE channel_id = $1
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                    await interaction.reply({

                        embeds: [

                            successEmbed(
                                "Ticket Closed",
                                "The ticket has been closed. The client has been asked for feedback. If they do not respond within 10 minutes, the ticket will be deleted.",
                                config.success_color
                            )
                        ]
                    });

                    await logTicket(
                        guild,
                        config,
                        "Ticket Closed",
                        `${interaction.user} closed ${interaction.channel}.`,
                        config.success_color
                    );

                    await requestTicketFeedback(
                        guild,
                        interaction.channel,
                        {
                            ...ticket,
                            claimer_id:
                                ticket.claimer_id ||
                                interaction.user.id
                        }
                    );

                    return;
                }
            }

            /* ============================================
               END BUTTONS
            ============================================ */

        } catch (error) {

            console.error(
                "[INTERACTION ERROR]",
                error
            );

            if (
                interaction.replied ||
                interaction.deferred
            ) {

                await interaction
                    .followUp({
                        embeds: [
                            errorEmbed(
                                "Error",
                                "Something went wrong while processing that request."
                            )
                        ],
                        ephemeral: true
                    })
                    .catch(() => {});

            } else {

                await interaction
                    .reply({
                        embeds: [
                            errorEmbed(
                                "Error",
                                "Something went wrong while processing that request."
                            )
                        ],
                        ephemeral: true
                    })
                    .catch(() => {});
            }
        }
    }
);

/* =========================================================
   TICKET CREATION
========================================================= */

async function createTicket(
    interaction,
    config
) {

    const guild = interaction.guild;

    const existing = await query(
        `
        SELECT *
        FROM tickets
        WHERE guild_id = $1
        AND opener_id = $2
        AND status != 'closed'
        `,
        [
            guild.id,
            interaction.user.id
        ]
    );

    if (existing.rows.length) {

        const existingChannel =
            guild.channels.cache.get(
                existing.rows[0].channel_id
            );

        return {
            success: false,
            channel: existingChannel
        };
    }

    const channel =
        await guild.channels.create({

            name:
                `ticket-${interaction.user.username}`
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "")
                    .slice(0, 80),

            type: ChannelType.GuildText,

            parent:
                config.category_id,

            permissionOverwrites: [

                {
                    id: guild.id,

                    deny: [
                        PermissionFlagsBits.ViewChannel
                    ]
                },

                {
                    id: interaction.user.id,

                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AddReactions,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                },

                {
                    id: config.support_role_id,

                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AddReactions,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                },

                {
                    id: config.management_role_id,

                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AddReactions,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                }
            ]
        });

    await query(
        `
        INSERT INTO tickets (
            channel_id,
            guild_id,
            opener_id,
            opener_tag,
            status
        )
        VALUES ($1,$2,$3,$4,'open')
        `,
        [
            channel.id,
            guild.id,
            interaction.user.id,
            interaction.user.tag
        ]
    );

    const ticket = {
        channel_id: channel.id,
        guild_id: guild.id,
        opener_id: interaction.user.id,
        opener_tag: interaction.user.tag,
        claimer_id: null,
        status: "open"
    };

    const opener =
        guild.members.cache.get(
            interaction.user.id
        );

    const embed =
        ticketEmbed(
            config,
            ticket,
            opener
        );

    await channel.send({

        content:
            `${interaction.user} <@&${config.support_role_id}>`,

        embeds: [embed],

        components: [
            ticketButtons()
        ]
    });

    await logTicket(
        guild,
        config,
        "Ticket Created",
        `${interaction.user} created ${channel}.`,
        config.ticket_color
    );

    return {
        success: true,
        channel
    };
}


/* =========================================================
   TICKET PANEL
========================================================= */

function ticketPanel(config) {

    const embed =
        new EmbedBuilder()
            .setTitle("🎫 Devil Support")
            .setDescription(
                "Need help? Open a support ticket using the button below.\n\n" +
                "Please provide as much information as possible so staff can assist you."
            )
            .addFields(
                {
                    name: "📌 Support",
                    value:
                        "Our support team will review your request.",
                    inline: false
                },
                {
                    name: "⚠️ Please Note",
                    value:
                        "Do not open multiple tickets for the same issue.",
                    inline: false
                }
            )
            .setColor(
                getColor(
                    config.panel_color ||
                    "blue"
                )
            )
            .setFooter({
                text: "Devil Support"
            })
            .setTimestamp();

    const row =
        new ActionRowBuilder()
            .addComponents(

                new ButtonBuilder()
                    .setCustomId(
                        "ticket_create"
                    )
                    .setLabel(
                        "Create Ticket"
                    )
                    .setEmoji("🎫")
                    .setStyle(
                        ButtonStyle.Primary
                    )
            );

    return {
        embeds: [embed],
        components: [row]
    };
}


/* =========================================================
   GET CURRENT TICKET
========================================================= */

async function getCurrentTicket(
    channelId
) {

    const result =
        await query(
            `
            SELECT *
            FROM tickets
            WHERE channel_id = $1
            `,
            [channelId]
        );

    return result.rows[0] || null;
}


/* =========================================================
   SECOND INTERACTION HANDLER
   SLASH COMMANDS
========================================================= */

client.on(
    "interactionCreate",
    async interaction => {

        if (
            !interaction.isChatInputCommand()
        ) {
            return;
        }

        try {

            const guild =
                interaction.guild;

            if (!guild) {

                return interaction.reply({
                    content:
                        "This command can only be used inside a server.",
                    ephemeral: true
                });
            }

            const config =
                await getTicketConfig(
                    guild.id
                );

            /* ==========================================
               /AUTH
            ========================================== */

            if (
                interaction.commandName ===
                "auth"
            ) {

                if (
                    !canManageTickets(
                        interaction.member,
                        config
                    ) &&
                    !isFinancialOperations(
                        interaction.member
                    )
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "No Permission",
                                "You do not have permission to authorize users."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const username =
                    interaction.options
                        .getString(
                            "robloxuser",
                            true
                        );

                await interaction.deferReply();

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                "User Not Found",
                                `I couldn't find the Roblox user **${username}**.`
                            )
                        ]
                    });
                }

                const result =
                    await saveAuthorization({
                        robloxUsername:
                            user.name,

                        robloxUserId:
                            user.id,

                        discordUserId:
                            interaction.user.id,

                        source:
                            "discord",

                        authorizedBy:
                            interaction.user.id
                    });

                if (
                    result.reason ===
                    "rban"
                ) {

                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                "Authorization Blocked",
                                "This Roblox account is currently rBanned."
                            )
                        ]
                    });
                }

                return interaction.editReply({
                    embeds: [
                        successEmbed(
                            "User Authorized",
                            `**${user.name}** has been authorized.\n\nRoblox ID: \`${user.id}\``,
                            config?.success_color ||
                            "green"
                        )
                    ]
                });
            }


            /* ==========================================
               /CHECK
            ========================================== */

            if (
                interaction.commandName ===
                "check"
            ) {

                if (
                    !canManageTickets(
                        interaction.member,
                        config
                    ) &&
                    !isFinancialOperations(
                        interaction.member
                    )
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "No Permission",
                                "You do not have permission to check authorizations."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const username =
                    interaction.options
                        .getString(
                            "robloxuser",
                            true
                        );

                await interaction.deferReply({
                    ephemeral: true
                });

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                "User Not Found",
                                `Roblox user **${username}** was not found.`
                            )
                        ]
                    });
                }

                const result =
                    await query(
                        `
                        SELECT *
                        FROM authorizations
                        WHERE roblox_user_id = $1
                        `,
                        [user.id]
                    );

                const record =
                    result.rows[0];

                if (!record) {

                    return interaction.editReply({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    "🔍 Authorization Check"
                                )
                                .setDescription(
                                    `**${user.name}** is not authorized.`
                                )
                                .setColor(
                                    getColor("red")
                                )
                                .setTimestamp()
                        ]
                    });
                }

                const blocked =
                    Boolean(
                        record.rban
                    );

                const authorized =
                    Boolean(
                        record.authorized
                    ) &&
                    !blocked;

                return interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                "🔍 Authorization Check"
                            )
                            .setDescription(
                                `**${user.name}**`
                            )
                            .addFields(
                                {
                                    name:
                                        "Authorization",
                                    value:
                                        authorized
                                            ? "✅ Authorized"
                                            : "❌ Not Authorized",
                                    inline: true
                                },
                                {
                                    name:
                                        "rBan",
                                    value:
                                        blocked
                                            ? "🔴 Yes"
                                            : "🟢 No",
                                    inline: true
                                },
                                {
                                    name:
                                        "Source",
                                    value:
                                        record.authorization_source ||
                                        "Unknown",
                                    inline: true
                                }
                            )
                            .setColor(
                                authorized
                                    ? getColor("green")
                                    : getColor("red")
                            )
                            .setTimestamp()
                    ]
                });
            }


            /* ==========================================
               /PROFILE
            ========================================== */

            if (
                interaction.commandName ===
                "profile"
            ) {

                const username =
                    interaction.options
                        .getString(
                            "robloxuser",
                            true
                        );

                await interaction.deferReply();

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                "User Not Found",
                                "That Roblox user could not be found."
                            )
                        ]
                    });
                }

                const profile =
                    await getRobloxProfile(
                        user.id
                    );

                const avatar =
                    await getRobloxAvatar(
                        user.id
                    );

                const friends =
                    await getRobloxFollowers(
                        user.id
                    );

                const embed =
                    new EmbedBuilder()
                        .setTitle(
                            `👤 ${user.name}`
                        )
                        .setURL(
                            `https://www.roblox.com/users/${user.id}/profile`
                        )
                        .setThumbnail(
                            avatar
                        )
                        .addFields(
                            {
                                name:
                                    "Display Name",
                                value:
                                    profile?.displayName ||
                                    user.displayName ||
                                    user.name,
                                inline: true
                            },
                            {
                                name:
                                    "User ID",
                                value:
                                    `${user.id}`,
                                inline: true
                            },
                            {
                                name:
                                    "Followers",
                                value:
                                    `${friends.followers}`,
                                inline: true
                            },
                            {
                                name:
                                    "Following",
                                value:
                                    `${friends.following}`,
                                inline: true
                            },
                            {
                                name:
                                    "Banned",
                                value:
                                    profile?.isBanned
                                        ? "🔴 Yes"
                                        : "🟢 No",
                                inline: true
                            }
                        )
                        .setColor(
                            getColor("blue")
                        )
                        .setTimestamp();

                return interaction.editReply({
                    embeds: [embed]
                });
            }


            /* ==========================================
               /HISTORY
            ========================================== */

            if (
                interaction.commandName ===
                "history"
            ) {

                if (
                    !canManageTickets(
                        interaction.member,
                        config
                    ) &&
                    !isFinancialOperations(
                        interaction.member
                    )
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "No Permission",
                                "You do not have permission to view authorization history."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const username =
                    interaction.options
                        .getString(
                            "robloxuser",
                            true
                        );

                await interaction.deferReply({
                    ephemeral: true
                });

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                "User Not Found",
                                "That Roblox user could not be found."
                            )
                        ]
                    });
                }

                const result =
                    await query(
                        `
                        SELECT *
                        FROM authorization_history
                        WHERE roblox_user_id = $1
                        ORDER BY created_at DESC
                        LIMIT 15
                        `,
                        [user.id]
                    );

                if (!result.rows.length) {

                    return interaction.editReply({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    "📜 Authorization History"
                                )
                                .setDescription(
                                    `No history exists for **${user.name}**.`
                                )
                                .setColor(
                                    getColor("dark")
                                )
                        ]
                    });
                }

                const description =
                    result.rows
                        .map(row => {

                            const date =
                                new Date(
                                    row.created_at
                                );

                            return (
                                `**${row.action}** — ` +
                                `${row.source || "Unknown"}\n` +
                                `<t:${Math.floor(
                                    date.getTime() / 1000
                                )}:R>`
                            );

                        })
                        .join("\n\n");

                return interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                `📜 History — ${user.name}`
                            )
                            .setDescription(
                                description
                            )
                            .setColor(
                                getColor("purple")
                            )
                            .setTimestamp()
                    ]
                });
            }


            /* ==========================================
               /ESCALATE
            ========================================== */

            if (
                interaction.commandName ===
                "escalate"
            ) {

                if (
                    !config ||
                    !canManageTickets(
                        interaction.member,
                        config
                    )
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "No Permission",
                                "You need Support or Management to escalate tickets."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const ticket =
                    await getCurrentTicket(
                        interaction.channel.id
                    );

                if (!ticket) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Not A Ticket",
                                "This channel is not a ticket."
                            )
                        ],
                        ephemeral: true
                    });
                }

                await query(
                    `
                    UPDATE tickets
                    SET
                        status = 'escalated',
                        escalated_by = $1,
                        escalated_at = NOW()
                    WHERE channel_id = $2
                    `,
                    [
                        interaction.user.id,
                        interaction.channel.id
                    ]
                );

                await interaction.reply({

                    content:
                        `<@&${MANAGER_ROLE_ID}>`,

                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                "⚠️ Ticket Escalated"
                            )
                            .setDescription(
                                `${interaction.user} has escalated this ticket.`
                            )
                            .setColor(
                                getColor("orange")
                            )
                            .setTimestamp()
                    ]
                });

                await logTicket(
                    guild,
                    config,
                    "Ticket Escalated",
                    `${interaction.user} escalated ${interaction.channel}.`,
                    "orange"
                );

                return;
            }


            /* ==========================================
               /STATS
            ========================================== */

            if (
                interaction.commandName ===
                "stats"
            ) {

                if (
                    !config ||
                    !canManageTickets(
                        interaction.member,
                        config
                    )
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "No Permission",
                                "You need Support or Management to view ticket statistics."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const total =
                    await query(
                        `
                        SELECT COUNT(*)::int AS count
                        FROM tickets
                        WHERE guild_id = $1
                        `,
                        [guild.id]
                    );

                const open =
                    await query(
                        `
                        SELECT COUNT(*)::int AS count
                        FROM tickets
                        WHERE guild_id = $1
                        AND status != 'closed'
                        `,
                        [guild.id]
                    );

                const claims =
                    await query(
                        `
                        SELECT COALESCE(
                            SUM(count),
                            0
                        )::int AS count
                        FROM ticket_claims
                        WHERE guild_id = $1
                        `,
                        [guild.id]
                    );

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                "📊 Ticket Statistics"
                            )
                            .addFields(
                                {
                                    name:
                                        "Total Tickets",
                                    value:
                                        `${total.rows[0].count}`,
                                    inline: true
                                },
                                {
                                    name:
                                        "Open Tickets",
                                    value:
                                        `${open.rows[0].count}`,
                                    inline: true
                                },
                                {
                                    name:
                                        "Total Claims",
                                    value:
                                        `${claims.rows[0].count}`,
                                    inline: true
                                }
                            )
                            .setColor(
                                getColor("blue")
                            )
                            .setTimestamp()
                    ]
                });
            }


            /* ==========================================
               /WIPE TICKETS
            ========================================== */

            if (
                interaction.commandName ===
                "wipetickets"
            ) {

                if (
                    !isFinancialOperations(
                        interaction.member
                    )
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "No Permission",
                                "Only Financial Operations can wipe ticket claim statistics."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const user =
                    interaction.options
                        .getUser(
                            "user",
                            true
                        );

                await wipeClaims(
                    guild.id,
                    user.id
                );

                await interaction.reply({
                    embeds: [
                        successEmbed(
                            "Statistics Wiped",
                            `All ticket claim statistics for ${user} have been wiped.`,
                            config?.success_color ||
                            "green"
                        )
                    ]
                });

                await updateLeaderboard(
                    guild
                );

                return;
            }


            /* ==========================================
               /TICKET
            ========================================== */

            if (
                interaction.commandName ===
                "ticket"
            ) {

                const subcommand =
                    interaction.options
                        .getSubcommand();


                /* ======================================
                   /TICKET SETUP
                ====================================== */

                if (
                    subcommand ===
                    "setup"
                ) {

                    if (
                        !isFinancialOperations(
                            interaction.member
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "Only Financial Operations can configure the ticket system."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const supportRole =
                        interaction.options
                            .getRole(
                                "support_role",
                                true
                            );

                    const managementRole =
                        interaction.options
                            .getRole(
                                "management_role",
                                true
                            );

                    const category =
                        interaction.options
                            .getChannel(
                                "category",
                                true
                            );

                    const logChannel =
                        interaction.options
                            .getChannel(
                                "log_channel"
                            );

                    const panelChannel =
                        interaction.options
                            .getChannel(
                                "panel_channel"
                            ) ||
                        interaction.channel;

                    const panelColor =
                        interaction.options
                            .getString(
                                "panel_color"
                            ) ||
                        "blue";

                    const ticketColor =
                        interaction.options
                            .getString(
                                "ticket_color"
                            ) ||
                        "blue";

                    const successColor =
                        interaction.options
                            .getString(
                                "success_color"
                            ) ||
                        "green";

                    const errorColor =
                        interaction.options
                            .getString(
                                "error_color"
                            ) ||
                        "red";

                    const leaderboardColor =
                        interaction.options
                            .getString(
                                "leaderboard_color"
                            ) ||
                        "purple";

                    await query(
                        `
                        INSERT INTO ticket_config (
                            guild_id,
                            support_role_id,
                            management_role_id,
                            category_id,
                            log_channel_id,
                            panel_channel_id,
                            panel_color,
                            ticket_color,
                            success_color,
                            error_color,
                            leaderboard_color
                        )
                        VALUES (
                            $1,$2,$3,$4,$5,$6,
                            $7,$8,$9,$10,$11
                        )

                        ON CONFLICT (guild_id)

                        DO UPDATE SET

                            support_role_id =
                                EXCLUDED.support_role_id,

                            management_role_id =
                                EXCLUDED.management_role_id,

                            category_id =
                                EXCLUDED.category_id,

                            log_channel_id =
                                EXCLUDED.log_channel_id,

                            panel_channel_id =
                                EXCLUDED.panel_channel_id,

                            panel_color =
                                EXCLUDED.panel_color,

                            ticket_color =
                                EXCLUDED.ticket_color,

                            success_color =
                                EXCLUDED.success_color,

                            error_color =
                                EXCLUDED.error_color,

                            leaderboard_color =
                                EXCLUDED.leaderboard_color
                        `,
                        [
                            guild.id,
                            supportRole.id,
                            managementRole.id,
                            category.id,
                            logChannel?.id ||
                                null,
                            panelChannel.id,
                            panelColor,
                            ticketColor,
                            successColor,
                            errorColor,
                            leaderboardColor
                        ]
                    );

                    const updatedConfig =
                        await getTicketConfig(
                            guild.id
                        );

                    const panel =
                        await panelChannel.send(
                            ticketPanel(
                                updatedConfig
                            )
                        );

                    await query(
                        `
                        UPDATE ticket_config
                        SET
                            panel_message_id = $1
                        WHERE guild_id = $2
                        `,
                        [
                            panel.id,
                            guild.id
                        ]
                    );

                    return interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket System Configured",
                                `Support: ${supportRole}\nManagement: ${managementRole}\nCategory: ${category}\nPanel: ${panelChannel}`,
                                successColor
                            )
                        ],
                        ephemeral: true
                    });
                }


                /* ======================================
                   /TICKET PANEL
                ====================================== */

                if (
                    subcommand ===
                    "panel"
                ) {

                    if (
                        !config
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Not Configured",
                                    "Run `/ticket setup` first."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        !isFinancialOperations(
                            interaction.member
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "Only Financial Operations can send the ticket panel."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const channel =
                        interaction.options
                            .getChannel(
                                "channel"
                            ) ||
                        interaction.channel;

                    const message =
                        await channel.send(
                            ticketPanel(
                                config
                            )
                        );

                    await query(
                        `
                        UPDATE ticket_config
                        SET
                            panel_channel_id = $1,
                            panel_message_id = $2
                        WHERE guild_id = $3
                        `,
                        [
                            channel.id,
                            message.id,
                            guild.id
                        ]
                    );

                    return interaction.reply({
                        embeds: [
                            successEmbed(
                                "Panel Sent",
                                `Ticket panel sent to ${channel}.`,
                                config.success_color
                            )
                        ],
                        ephemeral: true
                    });
                }


                /* ======================================
                   /TICKET CLAIM
                ====================================== */

                if (
                    subcommand ===
                    "claim"
                ) {

                    if (
                        !config ||
                        !canManageTickets(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "You need Support or Management to claim tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const ticket =
                        await getCurrentTicket(
                            interaction.channel.id
                        );

                    if (!ticket) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Not A Ticket",
                                    "This channel is not a ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        ticket.claimer_id
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Already Claimed",
                                    `This ticket is already claimed by <@${ticket.claimer_id}>.`
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await query(
                        `
                        UPDATE tickets
                        SET
                            claimer_id = $1,
                            claimed_at = NOW(),
                            status = 'claimed'
                        WHERE channel_id = $2
                        `,
                        [
                            interaction.user.id,
                            interaction.channel.id
                        ]
                    );

                    await addClaim(
                        guild.id,
                        interaction.user.id,
                        interaction.user.tag
                    );

                    /*
                       LOCK THE SUPPORT / MANAGEMENT
                       ROLES AFTER CLAIM.
                    */

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            config.support_role_id,
                            {
                                SendMessages: false,
                                AddReactions: false
                            }
                        )
                        .catch(() => {});

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            config.management_role_id,
                            {
                                SendMessages: false,
                                AddReactions: false
                            }
                        )
                        .catch(() => {});

                    /*
                       CLIENT CAN TALK.
                    */

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            ticket.opener_id,
                            {
                                ViewChannel: true,
                                SendMessages: true,
                                ReadMessageHistory: true,
                                AddReactions: true,
                                AttachFiles: true,
                                EmbedLinks: true
                            }
                        )
                        .catch(() => {});

                    /*
                       CLAIMED STAFF MEMBER CAN TALK.
                    */

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            interaction.user.id,
                            {
                                ViewChannel: true,
                                SendMessages: true,
                                ReadMessageHistory: true,
                                AddReactions: true,
                                AttachFiles: true,
                                EmbedLinks: true
                            }
                        )
                        .catch(() => {});

                    await interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket Claimed",
                                `${interaction.user} has claimed this ticket.\n\nOnly the client and assigned staff member can speak until another staff member is approved through **Request to Join**.`,
                                config.success_color
                            )
                        ]
                    });

                    await updateLeaderboard(
                        guild
                    );

                    return;
                }


                /* ======================================
                   /TICKET CLOSE
                ====================================== */

                if (
                    subcommand ===
                    "close"
                ) {

                    if (
                        !config ||
                        !canManageTickets(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "You need Support or Management to close tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const ticket =
                        await getCurrentTicket(
                            interaction.channel.id
                        );

                    if (!ticket) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Not A Ticket",
                                    "This channel is not a ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await query(
                        `
                        UPDATE tickets
                        SET
                            status = 'closed',
                            closed_at = NOW()
                        WHERE channel_id = $1
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                    await interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket Closed",
                                "The client has been asked for feedback. The ticket will automatically be deleted after 10 minutes if there is no response.",
                                config.success_color
                            )
                        ]
                    });

                    await requestTicketFeedback(
                        guild,
                        interaction.channel,
                        ticket
                    );

                    return;
                }


                /* ======================================
                   /TICKET UNCLAIM
                ====================================== */

                if (
                    subcommand ===
                    "unclaim"
                ) {

                    if (
                        !config ||
                        !canManageTickets(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "You need Support or Management to unclaim tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const ticket =
                        await getCurrentTicket(
                            interaction.channel.id
                        );

                    if (!ticket) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Not A Ticket",
                                    "This channel is not a ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        ticket.claimer_id !==
                            interaction.user.id &&
                        !isManagement(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Not Your Ticket",
                                    "Only the claimed staff member or Management can unclaim this ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await query(
                        `
                        UPDATE tickets
                        SET
                            claimer_id = NULL,
                            claimed_at = NULL,
                            status = 'open'
                        WHERE channel_id = $1
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                    await query(
                        `
                        DELETE FROM ticket_join_requests
                        WHERE channel_id = $1
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            config.support_role_id,
                            {
                                ViewChannel: true,
                                SendMessages: true,
                                ReadMessageHistory: true,
                                AddReactions: true
                            }
                        )
                        .catch(() => {});

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            config.management_role_id,
                            {
                                ViewChannel: true,
                                SendMessages: true,
                                ReadMessageHistory: true,
                                AddReactions: true
                            }
                        )
                        .catch(() => {});

                    return interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket Unclaimed",
                                "The ticket is open again and Support can respond.",
                                config.success_color
                            )
                        ]
                    });
                }


                /* ======================================
                   /TICKET RENAME
                ====================================== */

                if (
                    subcommand ===
                    "rename"
                ) {

                    if (
                        !config ||
                        !isSupport(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "Only Support can rename tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const name =
                        interaction.options
                            .getString(
                                "name",
                                true
                            )
                            .toLowerCase()
                            .replace(
                                /[^a-z0-9-]/g,
                                "-"
                            )
                            .slice(0, 90);

                    await interaction.channel
                        .setName(name);

                    return interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket Renamed",
                                `The ticket has been renamed to **${name}**.`,
                                config.success_color
                            )
                        ]
                    });
                }


                /* ======================================
                   /TICKET ADD
                ====================================== */

                if (
                    subcommand ===
                    "add"
                ) {

                    if (
                        !config ||
                        !isSupport(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "Only Support can add users to tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const user =
                        interaction.options
                            .getUser(
                                "user",
                                true
                            );

                    await interaction.channel
                        .permissionOverwrites
                        .edit(
                            user.id,
                            {
                                ViewChannel: true,
                                SendMessages: true,
                                ReadMessageHistory: true,
                                AddReactions: true,
                                AttachFiles: true,
                                EmbedLinks: true
                            }
                        );

                    return interaction.reply({
                        embeds: [
                            successEmbed(
                                "User Added",
                                `${user} has been added to this ticket.`,
                                config.success_color
                            )
                        ]
                    });
                }


                /* ======================================
                   /TICKET REMOVE
                ====================================== */

                if (
                    subcommand ===
                    "remove"
                ) {

                    if (
                        !config ||
                        !isSupport(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "Only Support can remove users from tickets."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const user =
                        interaction.options
                            .getUser(
                                "user",
                                true
                            );

                    const ticket =
                        await getCurrentTicket(
                            interaction.channel.id
                        );

                    if (
                        ticket?.opener_id ===
                        user.id
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Cannot Remove Client",
                                    "The ticket opener cannot be removed from their own ticket."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await interaction.channel
                        .permissionOverwrites
                        .delete(
                            user.id
                        )
                        .catch(() => {});

                    return interaction.reply({
                        embeds: [
                            successEmbed(
                                "User Removed",
                                `${user} has been removed from this ticket.`,
                                config.success_color
                            )
                        ]
                    });
                }
            }

        } catch (error) {

            console.error(
                "[SLASH COMMAND ERROR]",
                error
            );

            if (
                interaction.replied ||
                interaction.deferred
            ) {

                await interaction.followUp({
                    embeds: [
                        errorEmbed(
                            "Error",
                            "Something went wrong while processing the command."
                        )
                    ],
                    ephemeral: true
                }).catch(() => {});

            } else {

                await interaction.reply({
                    embeds: [
                        errorEmbed(
                            "Error",
                            "Something went wrong while processing the command."
                        )
                    ],
                    ephemeral: true
                }).catch(() => {});
            }
        }
    }
);


/* =========================================================
   TICKET CREATE BUTTON
========================================================= */

client.on(
    "interactionCreate",
    async interaction => {

        if (
            !interaction.isButton() ||
            interaction.customId !==
                "ticket_create"
        ) {
            return;
        }

        try {

            const guild =
                interaction.guild;

            if (!guild) {
                return;
            }

            const config =
                await getTicketConfig(
                    guild.id
                );

            if (!config) {

                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "Not Configured",
                            "The ticket system has not been configured yet."
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.deferReply({
                ephemeral: true
            });

            const result =
                await createTicket(
                    interaction,
                    config
                );

            if (!result.success) {

                if (result.channel) {

                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                "Ticket Already Open",
                                `You already have an open ticket: ${result.channel}`
                            )
                        ]
                    });
                }

                return interaction.editReply({
                    embeds: [
                        errorEmbed(
                            "Unable To Create",
                            "Your ticket could not be created."
                        )
                    ]
                });
            }

            await interaction.editReply({
                embeds: [
                    successEmbed(
                        "Ticket Created",
                        `Your ticket has been created: ${result.channel}`,
                        config.success_color
                    )
                ]
            });

        } catch (error) {

            console.error(
                "[CREATE TICKET ERROR]",
                error
            );

            if (
                interaction.deferred
            ) {

                await interaction.editReply({
                    embeds: [
                        errorEmbed(
                            "Error",
                            "Something went wrong while creating your ticket."
                        )
                    ]
                }).catch(() => {});

            } else {

                await interaction.reply({
                    embeds: [
                        errorEmbed(
                            "Error",
                            "Something went wrong while creating your ticket."
                        )
                    ],
                    ephemeral: true
                }).catch(() => {});
            }
        }
    }
);


/* =========================================================
   DIRECT MESSAGE FEEDBACK
========================================================= */

client.on(
    "messageCreate",
    async message => {

        try {

            if (message.author.bot) {
                return;
            }

            if (
                message.channel.type !==
                ChannelType.DM
            ) {
                return;
            }

            const pending =
                pendingFeedback.get(
                    message.author.id
                );

            if (!pending) {
                return;
            }

            if (pending.timeout) {
                clearTimeout(
                    pending.timeout
                );
            }

            pendingFeedback.delete(
                message.author.id
            );

            await sendFeedbackToStaff(
                message,
                pending
            );

            const guild =
                client.guilds.cache.get(
                    pending.guildId
                );

            const ticketChannel =
                guild?.channels.cache.get(
                    pending.channelId
                );

            if (!ticketChannel) {
                return;
            }

            const closeTimeout =
                setTimeout(
                    async () => {

                        pendingClose.delete(
                            message.author.id
                        );

                        await finishTicketClose(
                            ticketChannel,
                            message.author.id
                        );

                    },
                    10 * 60 * 1000
                );

            pendingClose.set(
                message.author.id,
                {
                    channelId:
                        pending.channelId,

                    guildId:
                        pending.guildId,

                    timeout:
                        closeTimeout
                }
            );

            await message.author.send({

                embeds: [

                    new EmbedBuilder()
                        .setTitle(
                            "⭐ Feedback Received"
                        )
                        .setDescription(
                            "Thank you for your feedback.\n\n" +
                            "Would you like the ticket to be deleted, or would you like to keep it open?"
                        )
                        .setColor(
                            getColor("green")
                        )
                        .setTimestamp()
                ],

                components: [
                    closeChoiceButtons()
                ]
            });

        } catch (error) {

            console.error(
                "[DM FEEDBACK ERROR]",
                error
            );
        }
    }
);


/* =========================================================
   DM FEEDBACK BUTTONS
========================================================= */

client.on(
    "interactionCreate",
    async interaction => {

        if (
            !interaction.isButton()
        ) {
            return;
        }

        if (
            interaction.customId !==
                "feedback_close_yes" &&
            interaction.customId !==
                "feedback_close_no"
        ) {
            return;
        }

        if (interaction.guild) {
            return;
        }

        try {

            const pending =
                pendingClose.get(
                    interaction.user.id
                );

            if (!pending) {

                return interaction.reply({
                    content:
                        "This ticket is no longer waiting for a close decision.",
                    ephemeral: true
                });
            }

            if (
                pending.timeout
            ) {

                clearTimeout(
                    pending.timeout
                );
            }

            pendingClose.delete(
                interaction.user.id
            );

            const guild =
                client.guilds.cache.get(
                    pending.guildId
                );

            const channel =
                guild?.channels.cache.get(
                    pending.channelId
                );

            if (
                interaction.customId ===
                "feedback_close_yes"
            ) {

                await interaction.update({

                    embeds: [

                        new EmbedBuilder()
                            .setTitle(
                                "🔒 Ticket Closed"
                            )
                            .setDescription(
                                "The ticket will now be deleted."
                            )
                            .setColor(
                                getColor("red")
                            )
                            .setTimestamp()
                    ],

                    components: []
                });

                if (channel) {

                    await query(
                        `
                        UPDATE tickets
                        SET
                            status = 'closed',
                            closed_at = NOW()
                        WHERE channel_id = $1
                        `,
                        [
                            pending.channelId
                        ]
                    );

                    setTimeout(
                        async () => {

                            await channel
                                .delete()
                                .catch(() => {});

                        },
                        3000
                    );
                }

                return;
            }

            /*
               NO = KEEP TICKET OPEN.
            */

            if (channel) {

                await query(
                    `
                    UPDATE tickets
                    SET
                        status =
                            CASE
                                WHEN claimer_id IS NULL
                                THEN 'open'
                                ELSE 'claimed'
                            END,
                        closed_at = NULL
                    WHERE channel_id = $1
                    `,
                    [
                        pending.channelId
                    ]
                );

                await interaction.update({

                    embeds: [

                        new EmbedBuilder()
                            .setTitle(
                                "↩️ Ticket Kept Open"
                            )
                            .setDescription(
                                "The ticket has been kept open."
                            )
                            .setColor(
                                getColor("green")
                            )
                            .setTimestamp()
                    ],

                    components: []
                });

            } else {

                await interaction.update({

                    embeds: [

                        new EmbedBuilder()
                            .setTitle(
                                "Ticket Not Found"
                            )
                            .setDescription(
                                "The ticket could not be found."
                            )
                            .setColor(
                                getColor("red")
                            )
                            .setTimestamp()
                    ],

                    components: []
                });
            }

        } catch (error) {

            console.error(
                "[DM BUTTON ERROR]",
                error
            );

            if (
                interaction.replied ||
                interaction.deferred
            ) {

                await interaction.followUp({
                    content:
                        "Something went wrong.",
                    ephemeral: true
                }).catch(() => {});

            } else {

                await interaction.reply({
                    content:
                        "Something went wrong.",
                    ephemeral: true
                }).catch(() => {});
            }
        }
    }
);


/* =========================================================
   SLASH COMMAND DEFINITIONS
========================================================= */

const commands = [

    new SlashCommandBuilder()
        .setName("auth")
        .setDescription(
            "Authorize a Roblox user"
        )
        .addStringOption(option =>
            option
                .setName("robloxuser")
                .setDescription(
                    "Roblox username"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("check")
        .setDescription(
            "Check Roblox authorization"
        )
        .addStringOption(option =>
            option
                .setName("robloxuser")
                .setDescription(
                    "Roblox username"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("profile")
        .setDescription(
            "View a Roblox profile"
        )
        .addStringOption(option =>
            option
                .setName("robloxuser")
                .setDescription(
                    "Roblox username"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("history")
        .setDescription(
            "View authorization history"
        )
        .addStringOption(option =>
            option
                .setName("robloxuser")
                .setDescription(
                    "Roblox username"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("escalate")
        .setDescription(
            "Escalate the current ticket"
        ),

    new SlashCommandBuilder()
        .setName("stats")
        .setDescription(
            "View ticket statistics"
        ),

    new SlashCommandBuilder()
        .setName("wipetickets")
        .setDescription(
            "Wipe ticket claim statistics"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Staff member"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("ticket")
        .setDescription(
            "Ticket management"
        )
        .addSubcommand(sub =>
            sub
                .setName("setup")
                .setDescription(
                    "Configure the ticket system"
                )
                .addRoleOption(option =>
                    option
                        .setName("support_role")
                        .setDescription(
                            "Support role"
                        )
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option
                        .setName("management_role")
                        .setDescription(
                            "Management role"
                        )
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName("category")
                        .setDescription(
                            "Ticket category"
                        )
                        .addChannelTypes(
                            ChannelType.GuildCategory
                        )
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName("log_channel")
                        .setDescription(
                            "Ticket log channel"
                        )
                        .addChannelTypes(
                            ChannelType.GuildText
                        )
                )
                .addChannelOption(option =>
                    option
                        .setName("panel_channel")
                        .setDescription(
                            "Ticket panel channel"
                        )
                        .addChannelTypes(
                            ChannelType.GuildText
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("panel_color")
                        .setDescription(
                            "Panel color"
                        )
                        .addChoices(
                            ...Object.keys(
                                COLORS
                            ).map(color => ({
                                name:
                                    color
                                        .charAt(0)
                                        .toUpperCase() +
                                    color.slice(1),
                                value:
                                    color
                            }))
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("ticket_color")
                        .setDescription(
                            "Ticket color"
                        )
                        .addChoices(
                            ...Object.keys(
                                COLORS
                            ).map(color => ({
                                name:
                                    color
                                        .charAt(0)
                                        .toUpperCase() +
                                    color.slice(1),
                                value:
                                    color
                            }))
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("success_color")
                        .setDescription(
                            "Success color"
                        )
                        .addChoices(
                            ...Object.keys(
                                COLORS
                            ).map(color => ({
                                name:
                                    color
                                        .charAt(0)
                                        .toUpperCase() +
                                    color.slice(1),
                                value:
                                    color
                            }))
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("error_color")
                        .setDescription(
                            "Error color"
                        )
                        .addChoices(
                            ...Object.keys(
                                COLORS
                            ).map(color => ({
                                name:
                                    color
                                        .charAt(0)
                                        .toUpperCase() +
                                    color.slice(1),
                                value:
                                    color
                            }))
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("leaderboard_color")
                        .setDescription(
                            "Leaderboard color"
                        )
                        .addChoices(
                            ...Object.keys(
                                COLORS
                            ).map(color => ({
                                name:
                                    color
                                        .charAt(0)
                                        .toUpperCase() +
                                    color.slice(1),
                                value:
                                    color
                            }))
                        )
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("panel")
                .setDescription(
                    "Send the ticket panel"
                )
                .addChannelOption(option =>
                    option
                        .setName("channel")
                        .setDescription(
                            "Channel to send the panel"
                        )
                        .addChannelTypes(
                            ChannelType.GuildText
                        )
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("claim")
                .setDescription(
                    "Claim the current ticket"
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("close")
                .setDescription(
                    "Close the current ticket"
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("unclaim")
                .setDescription(
                    "Unclaim the current ticket"
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("rename")
                .setDescription(
                    "Rename the current ticket"
                )
                .addStringOption(option =>
                    option
                        .setName("name")
                        .setDescription(
                            "New ticket name"
                        )
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("add")
                .setDescription(
                    "Add a user to the ticket"
                )
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription(
                            "User to add"
                        )
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("remove")
                .setDescription(
                    "Remove a user from the ticket"
                )
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription(
                            "User to remove"
                        )
                        .setRequired(true)
                )
        )
].map(command => command.toJSON());


/* =========================================================
   REGISTER COMMANDS
========================================================= */

client.once(
    "clientReady",
    async () => {

        try {

            await client.application.commands.set(
                commands
            );

            console.log(
                "[DISCORD] Slash commands registered."
            );

        } catch (error) {

            console.error(
                "[COMMAND REGISTRATION ERROR]",
                error
            );
        }
    }
);


/* =========================================================
   EXPRESS API
========================================================= */

const app =
    express();

app.use(
    express.json()
);

app.get(
    "/",
    (req, res) => {

        res.json({
            status: "online",
            service: "Devil",
            discord:
                client.isReady()
                    ? "online"
                    : "connecting"
        });
    }
);


/* =========================================================
   API AUTH
========================================================= */

function checkApiSecret(
    req
) {

    const supplied =
        req.headers[
            "x-api-secret"
        ] ||
        req.headers[
            "authorization"
        ]?.replace(
            /^Bearer\s+/i,
            ""
        );

    return (
        supplied === API_SECRET
    );
}


/* =========================================================
   GET /CHECK
========================================================= */

app.get(
    "/check",
    async (req, res) => {

        if (
            !checkApiSecret(req)
        ) {

            return res
                .status(401)
                .json({
                    error:
                        "Unauthorized"
                });
        }

        try {

            const username =
                req.query.username;

            if (!username) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Missing username"
                    });
            }

            const user =
                await getRobloxUser(
                    username
                );

            if (!user) {

                return res
                    .status(404)
                    .json({
                        error:
                            "Roblox user not found"
                    });
            }

            const result =
                await query(
                    `
                    SELECT *
                    FROM authorizations
                    WHERE roblox_user_id = $1
                    `,
                    [user.id]
                );

            const record =
                result.rows[0];

            if (!record) {

                return res.json({
                    username:
                        user.name,

                    userId:
                        user.id,

                    authorized:
                        false,

                    rban:
                        false
                });
            }

            return res.json({

                username:
                    record.roblox_username,

                userId:
                    record.roblox_user_id,

                authorized:
                    Boolean(
                        record.authorized
                    ) &&
                    !Boolean(
                        record.rban
                    ),

                rban:
                    Boolean(
                        record.rban
                    ),

                source:
                    record.authorization_source,

                authorizedAt:
                    record.authorized_at
            });

        } catch (error) {

            console.error(
                "[API CHECK ERROR]",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "Internal server error"
                });
        }
    }
);


/* =========================================================
   POST /BADGE-AUTHORIZE
========================================================= */

app.post(
    "/badge-authorize",
    async (req, res) => {

        if (
            !checkApiSecret(req)
        ) {

            return res
                .status(401)
                .json({
                    error:
                        "Unauthorized"
                });
        }

        try {

            const {
                robloxUsername,
                robloxUserId,
                discordUserId
            } = req.body;

            if (
                !robloxUsername ||
                !robloxUserId
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Missing Roblox user information"
                    });
            }

            const result =
                await saveAuthorization({

                    robloxUsername,

                    robloxUserId:
                        String(
                            robloxUserId
                        ),

                    discordUserId:
                        discordUserId ||
                        "ROBLOX_BADGE",

                    source:
                        "roblox-badge",

                    authorizedBy:
                        "ROBLOX_BADGE"
                });

            if (
                result.reason ===
                "rban"
            ) {

                return res
                    .status(403)
                    .json({
                        error:
                            "User is rBanned"
                    });
            }

            return res.json({
                success:
                    true,

                authorized:
                    true,

                username:
                    robloxUsername,

                userId:
                    robloxUserId
            });

        } catch (error) {

            console.error(
                "[BADGE AUTHORIZE ERROR]",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "Internal server error"
                });
        }
    }
);


/* =========================================================
   API ERROR HANDLER
========================================================= */

app.use(
    (error, req, res, next) => {

        console.error(
            "[EXPRESS ERROR]",
            error
        );

        res.status(500).json({
            error:
                "Internal server error"
        });
    }
);


/* =========================================================
   START WEB SERVER
========================================================= */

app.listen(
    PORT,
    () => {

        console.log(
            `[WEB] API listening on port ${PORT}`
        );
    }
);


/* =========================================================
   START DISCORD
========================================================= */

client.login(
    TOKEN
).catch(
    error => {

        console.error(
            "[DISCORD LOGIN ERROR]",
            error
        );

        /*
           Do not immediately terminate Railway.
           This allows the logs to show the actual
           Discord connection error.
        */
    }
);
