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

/* =========================================================
   CHECK ENVIRONMENT
========================================================= */

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
        CREATE TABLE IF NOT EXISTS ticket_feedback (
            id SERIAL PRIMARY KEY,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            opener_id TEXT NOT NULL,
            staff_id TEXT,
            feedback TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
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
   FEEDBACK STATE
========================================================= */

const pendingFeedback = new Map();
const pendingCloseChoice = new Map();

/* =========================================================
   PERMISSION HELPERS
========================================================= */

function hasRole(member, roleId) {
    return Boolean(
        member?.roles?.cache?.has(roleId)
    );
}

function isSupport(member, config = null) {

    if (
        config?.support_role_id &&
        hasRole(member, config.support_role_id)
    ) {
        return true;
    }

    return hasRole(member, SUPPORT_ROLE_ID);
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
   TICKET CONFIG
========================================================= */

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

/* =========================================================
   ROBLOX API HELPERS
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

        if (
            !response.data ||
            !response.data.data ||
            !response.data.data.length
        ) {
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
            followers: followers.data?.count || 0,
            following: following.data?.count || 0
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
                ? "AUTHORIZED"
                : "UNAUTHORIZED",
            source,
            discordUserId,
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
        .setColor(getColor(color));
}

function errorEmbed(
    title,
    description,
    color = "red"
) {

    return new EmbedBuilder()
        .setTitle(`❌ ${title}`)
        .setDescription(description)
        .setColor(getColor(color));
}

/* =========================================================
   TICKET EMBED
========================================================= */

function ticketEmbed(config, ticket) {

    let status =
        ticket.status?.toUpperCase() ||
        "OPEN";

    if (ticket.status === "escalated") {
        status = "ESCALATED";
    }

    return new EmbedBuilder()
        .setTitle("🎫 Devil Support Ticket")
        .setDescription(
            `Welcome <@${ticket.opener_id}>.\n\n` +
            `Please explain your issue clearly. ` +
            `A member of our support team will assist you.`
        )
        .addFields(
            {
                name: "Status",
                value: `\`${status}\``,
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
        .setColor(
            getColor(
                config?.ticket_color || "blue"
            )
        )
        .setFooter({
            text: "Devil Support"
        })
        .setTimestamp();
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
                .setStyle(
                    ButtonStyle.Primary
                ),

            new ButtonBuilder()
                .setCustomId("ticket_escalate")
                .setLabel("Escalate")
                .setEmoji("⚠️")
                .setStyle(
                    ButtonStyle.Secondary
                ),

            new ButtonBuilder()
                .setCustomId("ticket_close")
                .setLabel("Close")
                .setEmoji("🔒")
                .setStyle(
                    ButtonStyle.Danger
                )
        );
}

/* =========================================================
   TICKET LOGGING
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

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(getColor(color))
        .setTimestamp();

    await channel.send({
        embeds: [embed]
    }).catch(() => {});
}

/* =========================================================
   CLAIM SYSTEM
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
            count =
                ticket_claims.count + 1,
            user_tag =
                EXCLUDED.user_tag
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
        await getTicketConfig(guild.id);

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

    const result = await query(
        `
        SELECT
            user_id,
            user_tag,
            count
        FROM ticket_claims
        WHERE guild_id = $1
        ORDER BY count DESC
        LIMIT 10
        `,
        [guild.id]
    );

    let description =
        "No ticket claims have been recorded yet.";

    if (result.rows.length) {

        description =
            result.rows
                .map((row, index) => {

                    const position =
                        index + 1;

                    let prefix =
                        `${position}.`;

                    if (position === 1) {
                        prefix = "🥇";
                    }

                    if (position === 2) {
                        prefix = "🥈";
                    }

                    if (position === 3) {
                        prefix = "🥉";
                    }

                    return (
                        `${prefix} ` +
                        `<@${row.user_id}> — ` +
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
            .setColor(
                getColor(
                    config.leaderboard_color ||
                    "purple"
                )
            )
            .setFooter({
                text:
                    "Devil Support • Updates every 30 minutes"
            })
            .setTimestamp();

    let message = null;

    if (config.leaderboard_message_id) {

        message =
            await channel.messages
                .fetch(
                    config.leaderboard_message_id
                )
                .catch(() => null);
    }

    if (message) {

        await message.edit({
            embeds: [embed]
        }).catch(() => {});

    } else {

        const newMessage =
            await channel.send({
                embeds: [embed]
            });

        await query(
            `
            UPDATE ticket_config
            SET leaderboard_message_id = $1
            WHERE guild_id = $2
            `,
            [
                newMessage.id,
                guild.id
            ]
        );
    }
}

/* =========================================================
   FEEDBACK FLOW
========================================================= */

async function finishTicketClose(
    guildId,
    channelId
) {

    const guild =
        client.guilds.cache.get(guildId);

    if (!guild) {
        return;
    }

    const channel =
        guild.channels.cache.get(channelId);

    await query(
        `
        UPDATE tickets
        SET status = 'closed',
            closed_at = NOW()
        WHERE channel_id = $1
        `,
        [channelId]
    );

    const config =
        await getTicketConfig(guildId);

    if (config) {

        await logTicket(
            guild,
            config,
            "Ticket Closed",
            `<#${channelId}> has been closed.`,
            "red"
        );
    }

    if (channel) {

        await channel.send({
            embeds: [
                successEmbed(
                    "Ticket Closed",
                    "This ticket is now being closed."
                )
            ]
        }).catch(() => {});

        setTimeout(() => {

            channel.delete()
                .catch(() => {});

        }, 5000);
    }
}

async function beginFeedbackFlow(
    interaction,
    ticket,
    config
) {

    const opener =
        await client.users
            .fetch(ticket.opener_id)
            .catch(() => null);

    if (!opener) {

        await finishTicketClose(
            interaction.guild.id,
            interaction.channel.id
        );

        return;
    }

    const previousStatus =
        ticket.status === "feedback"
            ? "open"
            : ticket.status;

    await query(
        `
        UPDATE tickets
        SET status = 'feedback'
        WHERE channel_id = $1
        `,
        [interaction.channel.id]
    );

    const feedbackEmbed =
        new EmbedBuilder()
            .setTitle(
                "📝 Ticket Feedback"
            )
            .setDescription(
                "Your ticket is being closed.\n\n" +
                "Please reply to this DM with your feedback " +
                "about the support you received.\n\n" +
                "You have **10 minutes** to respond."
            )
            .setColor(
                getColor(
                    config.success_color ||
                    "green"
                )
            )
            .setFooter({
                text: "Devil Support"
            });

    try {

        await opener.send({
            embeds: [feedbackEmbed]
        });

    } catch {

        await finishTicketClose(
            interaction.guild.id,
            interaction.channel.id
        );

        return;
    }

    const timer =
        setTimeout(async () => {

            if (
                pendingFeedback.has(
                    opener.id
                )
            ) {

                pendingFeedback.delete(
                    opener.id
                );

                await finishTicketClose(
                    interaction.guild.id,
                    interaction.channel.id
                );
            }

        }, 10 * 60 * 1000);

    pendingFeedback.set(
        opener.id,
        {
            guildId:
                interaction.guild.id,

            channelId:
                interaction.channel.id,

            staffId:
                interaction.user.id,

            previousStatus,

            timer
        }
    );

    await interaction.reply({
        embeds: [
            successEmbed(
                "Feedback Requested",
                "The ticket opener has been sent a feedback request. " +
                "The ticket will remain here until they respond."
            )
        ],
        ephemeral: true
    });
}

/* =========================================================
   FEEDBACK MESSAGE HANDLER
========================================================= */

client.on(
    "messageCreate",
    async message => {

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

        clearTimeout(
            pending.timer
        );

        pendingFeedback.delete(
            message.author.id
        );

        await query(
            `
            INSERT INTO ticket_feedback (
                guild_id,
                channel_id,
                opener_id,
                staff_id,
                feedback
            )
            VALUES ($1,$2,$3,$4,$5)
            `,
            [
                pending.guildId,
                pending.channelId,
                message.author.id,
                pending.staffId,
                message.content
            ]
        );

        const guild =
            client.guilds.cache.get(
                pending.guildId
            );

        if (guild) {

            const feedbackChannel =
                guild.channels.cache.get(
                    FEEDBACK_CHANNEL_ID
                );

            if (feedbackChannel) {

                const embed =
                    new EmbedBuilder()
                        .setTitle(
                            "⭐ New Ticket Feedback"
                        )
                        .addFields(
                            {
                                name:
                                    "User",
                                value:
                                    `<@${message.author.id}>`,
                                inline: true
                            },
                            {
                                name:
                                    "Staff",
                                value:
                                    pending.staffId
                                        ? `<@${pending.staffId}>`
                                        : "Unknown",
                                inline: true
                            },
                            {
                                name:
                                    "Ticket",
                                value:
                                    `<#${pending.channelId}>`,
                                inline: true
                            },
                            {
                                name:
                                    "Feedback",
                                value:
                                    message.content
                                        .slice(
                                            0,
                                            1024
                                        )
                            }
                        )
                        .setColor(
                            getColor("green")
                        )
                        .setTimestamp();

                await feedbackChannel
                    .send({
                        embeds: [embed]
                    })
                    .catch(() => {});
            }
        }

        const row =
            new ActionRowBuilder()
                .addComponents(

                    new ButtonBuilder()
                        .setCustomId(
                            "feedback_close_yes"
                        )
                        .setLabel(
                            "Delete Ticket"
                        )
                        .setEmoji("🗑️")
                        .setStyle(
                            ButtonStyle.Danger
                        ),

                    new ButtonBuilder()
                        .setCustomId(
                            "feedback_close_no"
                        )
                        .setLabel(
                            "Keep Ticket Open"
                        )
                        .setEmoji("↩️")
                        .setStyle(
                            ButtonStyle.Secondary
                        )
                );

        await message.author.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle(
                        "Feedback Received"
                    )
                    .setDescription(
                        "Thank you for your feedback.\n\n" +
                        "Would you like the ticket to be deleted?"
                    )
                    .setColor(
                        getColor("green")
                    )
            ],
            components: [row]
        }).catch(() => {});

        const timer =
            setTimeout(async () => {

                if (
                    pendingCloseChoice.has(
                        message.author.id
                    )
                ) {

                    pendingCloseChoice.delete(
                        message.author.id
                    );

                    await finishTicketClose(
                        pending.guildId,
                        pending.channelId
                    );
                }

            }, 10 * 60 * 1000);

        pendingCloseChoice.set(
            message.author.id,
            {
                guildId:
                    pending.guildId,

                channelId:
                    pending.channelId,

                previousStatus:
                    pending.previousStatus,

                timer
            }
        );
    }
);

/* =========================================================
   SLASH COMMANDS
========================================================= */

const commands = [

    new SlashCommandBuilder()
        .setName("auth")
        .setDescription("Authorize a Roblox user")
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription("Roblox username")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("check")
        .setDescription("Check Roblox authorization")
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription("Roblox username")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("profile")
        .setDescription("View a Roblox profile")
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription("Roblox username")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("history")
        .setDescription("View authorization history")
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription("Roblox username")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("escalate")
        .setDescription("Escalate the current ticket"),

    new SlashCommandBuilder()
        .setName("stats")
        .setDescription("View ticket statistics"),

    new SlashCommandBuilder()
        .setName("wipetickets")
        .setDescription("Wipe a user's ticket claim statistics")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("User to wipe")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Ticket management")

        .addSubcommand(sub =>
            sub
                .setName("setup")
                .setDescription("Setup the ticket system")

                .addRoleOption(option =>
                    option
                        .setName("support_role")
                        .setDescription("Support role")
                        .setRequired(true)
                )

                .addRoleOption(option =>
                    option
                        .setName("management_role")
                        .setDescription("Management role")
                        .setRequired(true)
                )

                .addChannelOption(option =>
                    option
                        .setName("category")
                        .setDescription("Ticket category")
                        .addChannelTypes(
                            ChannelType.GuildCategory
                        )
                        .setRequired(true)
                )

                .addChannelOption(option =>
                    option
                        .setName("log_channel")
                        .setDescription("Ticket log channel")
                        .addChannelTypes(
                            ChannelType.GuildText
                        )
                        .setRequired(true)
                )

                .addStringOption(option =>
                    option
                        .setName("panel_color")
                        .setDescription("Panel colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(
                                color => ({
                                    name: color,
                                    value: color
                                })
                            )
                        )
                )

                .addStringOption(option =>
                    option
                        .setName("ticket_color")
                        .setDescription("Ticket colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(
                                color => ({
                                    name: color,
                                    value: color
                                })
                            )
                        )
                )

                .addStringOption(option =>
                    option
                        .setName("success_color")
                        .setDescription("Success colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(
                                color => ({
                                    name: color,
                                    value: color
                                })
                            )
                        )
                )

                .addStringOption(option =>
                    option
                        .setName("error_color")
                        .setDescription("Error colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(
                                color => ({
                                    name: color,
                                    value: color
                                })
                            )
                        )
                )

                .addStringOption(option =>
                    option
                        .setName("leaderboard_color")
                        .setDescription("Leaderboard colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(
                                color => ({
                                    name: color,
                                    value: color
                                })
                            )
                        )
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("panel")
                .setDescription("Send the ticket panel")
        )

        .addSubcommand(sub =>
            sub
                .setName("claim")
                .setDescription("Claim this ticket")
        )

        .addSubcommand(sub =>
            sub
                .setName("close")
                .setDescription("Close this ticket")
        )

        .addSubcommand(sub =>
            sub
                .setName("unclaim")
                .setDescription("Unclaim this ticket")
        )

        .addSubcommand(sub =>
            sub
                .setName("rename")
                .setDescription("Rename this ticket")
                .addStringOption(option =>
                    option
                        .setName("name")
                        .setDescription("New ticket name")
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("add")
                .setDescription("Add a user to this ticket")
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription("User")
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("remove")
                .setDescription("Remove a user from this ticket")
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription("User")
                        .setRequired(true)
                )
        )

].map(command => command.toJSON());


/* =========================================================
   TICKET PANEL
========================================================= */

async function sendTicketPanel(
    interaction,
    config
) {

    const embed =
        new EmbedBuilder()
            .setTitle("🎫 Devil Support")
            .setDescription(
                "Need help?\n\n" +
                "Click the button below to create a support ticket.\n\n" +
                "Please provide as much information as possible " +
                "when opening your ticket."
            )
            .addFields({
                name: "Support",
                value:
                    `<@&${config.support_role_id}>`,
                inline: true
            })
            .setColor(
                getColor(
                    config.panel_color ||
                    "blue"
                )
            )
            .setFooter({
                text: "Devil Support System"
            });

    const buttons =
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

    const message =
        await interaction.channel.send({
            embeds: [embed],
            components: [buttons]
        });

    await query(
        `
        UPDATE ticket_config
        SET
            panel_channel_id = $1,
            panel_message_id = $2
        WHERE guild_id = $3
        `,
        [
            interaction.channel.id,
            message.id,
            interaction.guild.id
        ]
    );

    return message;
}


/* =========================================================
   TICKET CREATION
========================================================= */

async function createTicket(interaction) {

    const guild = interaction.guild;

    if (!guild) {
        return;
    }

    const config =
        await getTicketConfig(guild.id);

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

    const existing =
        await query(
            `
            SELECT *
            FROM tickets
            WHERE guild_id = $1
            AND opener_id = $2
            AND status != 'closed'
            LIMIT 1
            `,
            [
                guild.id,
                interaction.user.id
            ]
        );

    if (existing.rows.length) {

        const oldChannel =
            guild.channels.cache.get(
                existing.rows[0].channel_id
            );

        if (oldChannel) {

            return interaction.reply({
                embeds: [
                    errorEmbed(
                        "Ticket Already Open",
                        `You already have a ticket: ${oldChannel}`
                    )
                ],
                ephemeral: true
            });
        }

        await query(
            `
            DELETE FROM tickets
            WHERE channel_id = $1
            `,
            [
                existing.rows[0].channel_id
            ]
        );
    }

    const safeName =
        interaction.user.username
            .toLowerCase()
            .replace(
                /[^a-z0-9-]/g,
                "-"
            )
            .replace(
                /-+/g,
                "-"
            )
            .slice(0, 70);

    const channel =
        await guild.channels.create({

            name:
                `ticket-${safeName}`,

            type:
                ChannelType.GuildText,

            parent:
                config.category_id,

            permissionOverwrites: [

                {
                    id:
                        guild.roles.everyone.id,

                    deny: [
                        PermissionFlagsBits.ViewChannel
                    ]
                },

                {
                    id:
                        interaction.user.id,

                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                },

                {
                    id:
                        config.support_role_id,

                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                },

                {
                    id:
                        config.management_role_id,

                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                }
            ]
        });

    const ticket = {
        channel_id:
            channel.id,

        guild_id:
            guild.id,

        opener_id:
            interaction.user.id,

        opener_tag:
            interaction.user.tag,

        claimer_id:
            null,

        status:
            "open"
    };

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

    await channel.send({
        content:
            `<@${interaction.user.id}> <@&${config.support_role_id}>`,

        embeds: [
            ticketEmbed(
                config,
                ticket
            )
        ],

        components: [
            ticketButtons()
        ]
    });

    await logTicket(
        guild,
        config,
        "Ticket Created",
        `${channel} was opened by ${interaction.user}.`,
        "green"
    );

    await interaction.reply({
        embeds: [
            successEmbed(
                "Ticket Created",
                `Your ticket has been created: ${channel}`,
                config.success_color
            )
        ],
        ephemeral: true
    });
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
   BUTTON INTERACTIONS
========================================================= */

client.on(
    "interactionCreate",
    async interaction => {

        if (!interaction.isButton()) {
            return;
        }

        /* ================================================
           FEEDBACK DELETE
        ================================================ */

        if (
            interaction.customId ===
            "feedback_close_yes"
        ) {

            const pending =
                pendingCloseChoice.get(
                    interaction.user.id
                );

            if (!pending) {

                return interaction.reply({
                    content:
                        "This feedback request has expired.",
                    ephemeral: true
                });
            }

            clearTimeout(
                pending.timer
            );

            pendingCloseChoice.delete(
                interaction.user.id
            );

            await interaction.reply({
                embeds: [
                    successEmbed(
                        "Ticket Deleting",
                        "The ticket will now be deleted."
                    )
                ]
            });

            await finishTicketClose(
                pending.guildId,
                pending.channelId
            );

            return;
        }


        /* ================================================
           FEEDBACK KEEP OPEN
        ================================================ */

        if (
            interaction.customId ===
            "feedback_close_no"
        ) {

            const pending =
                pendingCloseChoice.get(
                    interaction.user.id
                );

            if (!pending) {

                return interaction.reply({
                    content:
                        "This feedback request has expired.",
                    ephemeral: true
                });
            }

            clearTimeout(
                pending.timer
            );

            pendingCloseChoice.delete(
                interaction.user.id
            );

            await query(
                `
                UPDATE tickets
                SET status = $1
                WHERE channel_id = $2
                `,
                [
                    pending.previousStatus ||
                        "open",

                    pending.channelId
                ]
            );

            await interaction.reply({
                embeds: [
                    successEmbed(
                        "Ticket Kept Open",
                        "The ticket will remain open."
                    )
                ]
            });

            const guild =
                client.guilds.cache.get(
                    pending.guildId
                );

            if (guild) {

                const channel =
                    guild.channels.cache.get(
                        pending.channelId
                    );

                if (channel) {

                    await channel.send({
                        embeds: [
                            successEmbed(
                                "Ticket Reopened",
                                `${interaction.user} chose to keep this ticket open.`
                            )
                        ]
                    }).catch(() => {});
                }
            }

            return;
        }


        /* ================================================
           TICKET CREATE
        ================================================ */

        if (
            interaction.customId ===
            "ticket_create"
        ) {

            await createTicket(
                interaction
            );

            return;
        }


        /* ================================================
           NORMAL TICKET BUTTONS
        ================================================ */

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
                        "The ticket system is not configured."
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
                        "This channel is not a registered ticket."
                    )
                ],
                ephemeral: true
            });
        }


        /* ================================================
           CLAIM
        ================================================ */

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
                ticket.claimer_id &&
                ticket.claimer_id !==
                    interaction.user.id
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

            await interaction.channel.permissionOverwrites
                .edit(
                    interaction.user.id,
                    {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    }
                )
                .catch(() => {});

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
                "blue"
            );

            await updateLeaderboard(
                guild
            );

            return;
        }


        /* ================================================
           ESCALATE
        ================================================ */

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
                            `${interaction.user} has escalated this ticket to the Moderator/Manager team.`
                        )
                        .setColor(
                            getColor(
                                "orange"
                            )
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


        /* ================================================
           CLOSE
        ================================================ */

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

            await beginFeedbackFlow(
                interaction,
                ticket,
                config
            );

            return;
        }
    }
);


/* =========================================================
   SLASH COMMAND HANDLER
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
                    embeds: [
                        errorEmbed(
                            "Server Only",
                            "This command can only be used inside a server."
                        )
                    ],
                    ephemeral: true
                });
            }


            /* ============================================
               AUTH
            ============================================ */

            if (
                interaction.commandName ===
                "auth"
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
                                "You need Financial Operations to authorize users."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const username =
                    interaction.options
                        .getString(
                            "username",
                            true
                        );

                const roblox =
                    await getRobloxUser(
                        username
                    );

                if (!roblox) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "User Not Found",
                                `I couldn't find the Roblox user \`${username}\`.`
                            )
                        ],
                        ephemeral: true
                    });
                }

                const result =
                    await saveAuthorization({
                        robloxUsername:
                            roblox.name,

                        robloxUserId:
                            roblox.id,

                        discordUserId:
                            interaction.user.id,

                        source:
                            "discord",

                        authorizedBy:
                            interaction.user.tag
                    });

                if (
                    !result.success &&
                    result.reason ===
                        "rban"
                ) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Authorization Blocked",
                                "This Roblox account is rBanned and cannot be authorized."
                            )
                        ],
                        ephemeral: true
                    });
                }

                return interaction.reply({
                    embeds: [
                        successEmbed(
                            "User Authorized",
                            `**${roblox.name}** has been authorized successfully.`
                        )
                    ]
                });
            }


            /* ============================================
               CHECK
            ============================================ */

            if (
                interaction.commandName ===
                "check"
            ) {

                const username =
                    interaction.options
                        .getString(
                            "username",
                            true
                        );

                const roblox =
                    await getRobloxUser(
                        username
                    );

                if (!roblox) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "User Not Found",
                                `I couldn't find \`${username}\` on Roblox.`
                            )
                        ],
                        ephemeral: true
                    });
                }

                const result =
                    await query(
                        `
                        SELECT *
                        FROM authorizations
                        WHERE roblox_user_id = $1
                        `,
                        [roblox.id]
                    );

                const row =
                    result.rows[0];

                if (!row) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Not Authorized",
                                `**${roblox.name}** is not currently authorized.`
                            )
                        ]
                    });
                }

                if (row.rban) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "rBanned",
                                `**${roblox.name}** is blocked from authorization.`
                            )
                        ]
                    });
                }

                return interaction.reply({
                    embeds: [
                        successEmbed(
                            "Authorization Check",
                            `**${roblox.name}** is currently **authorized**.`
                        )
                    ]
                });
            }


            /* ============================================
               PROFILE
            ============================================ */

            if (
                interaction.commandName ===
                "profile"
            ) {

                const username =
                    interaction.options
                        .getString(
                            "username",
                            true
                        );

                const roblox =
                    await getRobloxUser(
                        username
                    );

                if (!roblox) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "User Not Found",
                                `I couldn't find \`${username}\`.`
                            )
                        ],
                        ephemeral: true
                    });
                }

                const profile =
                    await getRobloxProfile(
                        roblox.id
                    );

                const avatar =
                    await getRobloxAvatar(
                        roblox.id
                    );

                const counts =
                    await getRobloxFollowers(
                        roblox.id
                    );

                const embed =
                    new EmbedBuilder()
                        .setTitle(
                            `${roblox.name}'s Roblox Profile`
                        )
                        .addFields(
                            {
                                name: "Username",
                                value:
                                    roblox.name,
                                inline: true
                            },
                            {
                                name: "Display Name",
                                value:
                                    roblox.displayName ||
                                    roblox.name,
                                inline: true
                            },
                            {
                                name: "User ID",
                                value:
                                    String(
                                        roblox.id
                                    ),
                                inline: true
                            },
                            {
                                name: "Followers",
                                value:
                                    String(
                                        counts.followers
                                    ),
                                inline: true
                            },
                            {
                                name: "Following",
                                value:
                                    String(
                                        counts.following
                                    ),
                                inline: true
                            },
                            {
                                name: "Banned",
                                value:
                                    profile?.isBanned
                                        ? "Yes"
                                        : "No",
                                inline: true
                            }
                        )
                        .setColor(
                            getColor("blue")
                        )
                        .setTimestamp();

                if (avatar) {
                    embed.setThumbnail(
                        avatar
                    );
                }

                return interaction.reply({
                    embeds: [embed]
                });
            }


            /* ============================================
               HISTORY
            ============================================ */

            if (
                interaction.commandName ===
                "history"
            ) {

                const username =
                    interaction.options
                        .getString(
                            "username",
                            true
                        );

                const roblox =
                    await getRobloxUser(
                        username
                    );

                if (!roblox) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "User Not Found",
                                `I couldn't find \`${username}\`.`
                            )
                        ],
                        ephemeral: true
                    });
                }

                const result =
                    await query(
                        `
                        SELECT *
                        FROM authorization_history
                        WHERE roblox_user_id = $1
                        ORDER BY created_at DESC
                        LIMIT 10
                        `,
                        [roblox.id]
                    );

                if (!result.rows.length) {

                    return interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    "Authorization History"
                                )
                                .setDescription(
                                    `No authorization history exists for **${roblox.name}**.`
                                )
                                .setColor(
                                    getColor(
                                        "blue"
                                    )
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
                                ).toLocaleString(
                                    "en-GB"
                                );

                            return (
                                `**${row.action}** — ` +
                                `${row.source || "unknown"} — ` +
                                `${date}`
                            );
                        })
                        .join("\n");

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                `History — ${roblox.name}`
                            )
                            .setDescription(
                                description
                            )
                            .setColor(
                                getColor(
                                    "purple"
                                )
                            )
                    ]
                });
            }


            /* ============================================
               ESCALATE COMMAND
            ============================================ */

            if (
                interaction.commandName ===
                "escalate"
            ) {

                const config =
                    await getTicketConfig(
                        guild.id
                    );

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
                                "You need Support or Management."
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
                                "This command must be used inside a ticket."
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
                                `${interaction.user} escalated this ticket.`
                            )
                            .setColor(
                                getColor(
                                    "orange"
                                )
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


            /* ============================================
               STATS
            ============================================ */

            if (
                interaction.commandName ===
                "stats"
            ) {

                const config =
                    await getTicketConfig(
                        guild.id
                    );

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
                                "You need Support or Management."
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
                                        String(
                                            total.rows[0].count
                                        ),
                                    inline: true
                                },
                                {
                                    name:
                                        "Open Tickets",
                                    value:
                                        String(
                                            open.rows[0].count
                                        ),
                                    inline: true
                                },
                                {
                                    name:
                                        "Total Claims",
                                    value:
                                        String(
                                            claims.rows[0].count
                                        ),
                                    inline: true
                                }
                            )
                            .setColor(
                                getColor(
                                    "blue"
                                )
                            )
                    ]
                });
            }


            /* ============================================
               WIPE TICKETS
            ============================================ */

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
                                "You need Financial Operations."
                            )
                        ],
                        ephemeral: true
                    });
                }

                const user =
                    interaction.options.getUser(
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
                            "Claims Wiped",
                            `All ticket claim statistics for ${user} have been wiped.`
                        )
                    ]
                });

                await updateLeaderboard(
                    guild
                );

                return;
            }


            /* ============================================
               TICKET COMMAND
            ============================================ */

            if (
                interaction.commandName ===
                "ticket"
            ) {

                const subcommand =
                    interaction.options
                        .getSubcommand();

                const config =
                    await getTicketConfig(
                        guild.id
                    );


                /* ========================================
                   SETUP
                ======================================== */

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
                                    "You need Financial Operations to setup tickets."
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
                                "log_channel",
                                true
                            );

                    const panelColor =
                        interaction.options
                            .getString(
                                "panel_color",
                                true
                            );

                    const ticketColor =
                        interaction.options
                            .getString(
                                "ticket_color",
                                true
                            );

                    const successColor =
                        interaction.options
                            .getString(
                                "success_color",
                                true
                            );

                    const errorColor =
                        interaction.options
                            .getString(
                                "error_color",
                                true
                            );

                    const leaderboardColor =
                        interaction.options
                            .getString(
                                "leaderboard_color",
                                true
                            );

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
                            $1,$2,$3,$4,$5,
                            $6,$7,$8,$9,$10,$11
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
                            logChannel.id,
                            interaction.channel.id,
                            panelColor,
                            ticketColor,
                            successColor,
                            errorColor,
                            leaderboardColor
                        ]
                    );

                    const newConfig =
                        await getTicketConfig(
                            guild.id
                        );

                    await sendTicketPanel(
                        interaction,
                        newConfig
                    );

                    await interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket System Setup",
                                "The ticket system has been configured and the panel has been created."
                            )
                        ],
                        ephemeral: true
                    });

                    await updateLeaderboard(
                        guild
                    );

                    return;
                }


                /* ========================================
                   PANEL
                ======================================== */

                if (
                    subcommand ===
                    "panel"
                ) {

                    if (!config) {

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
                        ) &&
                        !isSupport(
                            interaction.member,
                            config
                        )
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "No Permission",
                                    "You need Financial Operations or Support."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await sendTicketPanel(
                        interaction,
                        config
                    );

                    return interaction.reply({
                        embeds: [
                            successEmbed(
                                "Panel Sent",
                                "The ticket panel has been sent."
                            )
                        ],
                        ephemeral: true
                    });
                }


                /* ========================================
                   CURRENT TICKET
                ======================================== */

                const ticket =
                    await getCurrentTicket(
                        interaction.channel.id
                    );

                if (!ticket) {

                    return interaction.reply({
                        embeds: [
                            errorEmbed(
                                "Not A Ticket",
                                "This command must be used inside a ticket."
                            )
                        ],
                        ephemeral: true
                    });
                }


                /* ========================================
                   CLAIM
                ======================================== */

                if (
                    subcommand ===
                    "claim"
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
                                    "You need Support or Management."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        ticket.claimer_id &&
                        ticket.claimer_id !==
                            interaction.user.id
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

                    await interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket Claimed",
                                `${interaction.user} has claimed this ticket.`
                            )
                        ]
                    });

                    await updateLeaderboard(
                        guild
                    );

                    return;
                }


                /* ========================================
                   UNCLAIM
                ======================================== */

                if (
                    subcommand ===
                    "unclaim"
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
                                    "You need Support or Management."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    if (
                        !ticket.claimer_id
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Not Claimed",
                                    "This ticket is not currently claimed."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    const oldClaimer =
                        ticket.claimer_id;

                    await query(
                        `
                        UPDATE tickets
                        SET
                            claimer_id = NULL,
                            claimed_at = NULL,
                            status =
                                CASE
                                    WHEN status = 'escalated'
                                    THEN 'escalated'
                                    ELSE 'open'
                                END
                        WHERE channel_id = $1
                        `,
                        [
                            interaction.channel.id
                        ]
                    );

                    await interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket Unclaimed",
                                `<@${oldClaimer}> is no longer assigned to this ticket.`
                            )
                        ]
                    });

                    await logTicket(
                        guild,
                        config,
                        "Ticket Unclaimed",
                        `${interaction.user} unclaimed ${interaction.channel}.`,
                        "orange"
                    );

                    return;
                }


                /* ========================================
                   CLOSE
                ======================================== */

                if (
                    subcommand ===
                    "close"
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
                                    "You need Support or Management."
                                )
                            ],
                            ephemeral: true
                        });
                    }

                    await beginFeedbackFlow(
                        interaction,
                        ticket,
                        config
                    );

                    return;
                }


                /* ========================================
                   RENAME
                ======================================== */

                if (
                    subcommand ===
                    "rename"
                ) {

                    if (
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
                                /[^a-z0-9-_]/g,
                                "-"
                            )
                            .slice(0, 90);

                    await interaction.channel
                        .setName(name);

                    return interaction.reply({
                        embeds: [
                            successEmbed(
                                "Ticket Renamed",
                                `The ticket has been renamed to \`${name}\`.`
                            )
                        ]
                    });
                }


                /* ========================================
                   ADD USER
                ======================================== */

                if (
                    subcommand ===
                    "add"
                ) {

                    if (
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
                                ReadMessageHistory: true
                            }
                        );

                    return interaction.reply({
                        embeds: [
                            successEmbed(
                                "User Added",
                                `${user} has been added to this ticket.`
                            )
                        ]
                    });
                }


                /* ========================================
                   REMOVE USER
                ======================================== */

                if (
                    subcommand ===
                    "remove"
                ) {

                    if (
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

                    if (
                        user.id ===
                        ticket.opener_id
                    ) {

                        return interaction.reply({
                            embeds: [
                                errorEmbed(
                                    "Cannot Remove",
                                    "You cannot remove the ticket opener."
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
                                `${user} has been removed from this ticket.`
                            )
                        ]
                    });
                }
            }

        } catch (error) {

            console.error(
                "[INTERACTION ERROR]",
                error
            );

            const embed =
                errorEmbed(
                    "Error",
                    "Something went wrong while processing that request."
                );

            if (
                interaction.replied ||
                interaction.deferred
            ) {

                await interaction
                    .followUp({
                        embeds: [embed],
                        ephemeral: true
                    })
                    .catch(() => {});

            } else {

                await interaction
                    .reply({
                        embeds: [embed],
                        ephemeral: true
                    })
                    .catch(() => {});
            }
        }
    }
);


/* =========================================================
   EXPRESS API
========================================================= */

const app = express();

app.use(
    express.json()
);

app.get(
    "/",
    (req, res) => {

        res.json({
            status: "online",
            service: "Devil",
            bot:
                client.user
                    ? client.user.tag
                    : "starting"
        });
    }
);


/* =========================================================
   API AUTHENTICATION
========================================================= */

function checkApiSecret(req, res) {

    const supplied =
        req.headers[
            "x-api-secret"
        ] ||
        req.body?.api_secret;

    if (
        !supplied ||
        supplied !== API_SECRET
    ) {

        res.status(401).json({
            success: false,
            error: "Unauthorized"
        });

        return false;
    }

    return true;
}


/* =========================================================
   CHECK AUTHORIZATION API
========================================================= */

app.get(
    "/check",
    async (req, res) => {

        try {

            if (
                !checkApiSecret(
                    req,
                    res
                )
            ) {
                return;
            }

            const username =
                String(
                    req.query.username ||
                    ""
                ).trim();

            if (!username) {

                return res.status(400)
                    .json({
                        success: false,
                        error:
                            "Missing username"
                    });
            }

            const roblox =
                await getRobloxUser(
                    username
                );

            if (!roblox) {

                return res.status(404)
                    .json({
                        success: false,
                        authorized: false,
                        error:
                            "Roblox user not found"
                    });
            }

            const result =
                await query(
                    `
                    SELECT
                        roblox_username,
                        roblox_user_id,
                        discord_user_id,
                        authorized,
                        authorization_source,
                        authorized_at,
                        rban
                    FROM authorizations
                    WHERE roblox_user_id = $1
                    `,
                    [roblox.id]
                );

            if (
                !result.rows.length
            ) {

                return res.json({
                    success: true,
                    authorized: false,
                    rban: false,
                    username:
                        roblox.name,
                    roblox_user_id:
                        roblox.id
                });
            }

            const row =
                result.rows[0];

            return res.json({
                success: true,
                authorized:
                    Boolean(
                        row.authorized &&
                        !row.rban
                    ),
                rban:
                    Boolean(row.rban),
                username:
                    row.roblox_username,
                roblox_user_id:
                    String(
                        row.roblox_user_id
                    ),
                discord_user_id:
                    row.discord_user_id,
                source:
                    row.authorization_source,
                authorized_at:
                    row.authorized_at
            });

        } catch (error) {

            console.error(
                "[API CHECK ERROR]",
                error
            );

            return res.status(500)
                .json({
                    success: false,
                    error:
                        "Internal server error"
                });
        }
    }
);


/* =========================================================
   BADGE AUTHORIZE API
========================================================= */

app.post(
    "/badge-authorize",
    async (req, res) => {

        try {

            if (
                !checkApiSecret(
                    req,
                    res
                )
            ) {
                return;
            }

            const {
                roblox_username,
                roblox_user_id,
                discord_user_id
            } = req.body;

            if (
                !roblox_username ||
                !roblox_user_id
            ) {

                return res.status(400)
                    .json({
                        success: false,
                        error:
                            "Missing Roblox information"
                    });
            }

            const result =
                await saveAuthorization({
                    robloxUsername:
                        String(
                            roblox_username
                        ),

                    robloxUserId:
                        String(
                            roblox_user_id
                        ),

                    discordUserId:
                        discord_user_id
                            ? String(
                                discord_user_id
                            )
                            : "roblox",

                    source:
                        "roblox-badge",

                    authorizedBy:
                        "Roblox Badge Sync"
                });

            if (
                !result.success
            ) {

                return res.status(403)
                    .json({
                        success: false,
                        authorized: false,
                        reason:
                            result.reason
                    });
            }

            return res.json({
                success: true,
                authorized: true,
                badge_id:
                    BADGE_ID
            });

        } catch (error) {

            console.error(
                "[BADGE API ERROR]",
                error
            );

            return res.status(500)
                .json({
                    success: false,
                    error:
                        "Internal server error"
                });
        }
    }
);


/* =========================================================
   EXPRESS ERROR HANDLER
========================================================= */

app.use(
    (error, req, res, next) => {

        console.error(
            "[EXPRESS ERROR]",
            error
        );

        if (res.headersSent) {
            return next(error);
        }

        res.status(500).json({
            success: false,
            error:
                "Internal server error"
        });
    }
);


/* =========================================================
   START EXPRESS
========================================================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `[WEB] API listening on port ${PORT}`
        );
    }
);


/* =========================================================
   DISCORD READY
========================================================= */

client.once(
    "clientReady",
    async () => {

        console.log(
            `[DISCORD] Logged in as ${client.user.tag}`
        );

        try {

            await setupDatabase();

            await client.application.commands
                .set(commands);

            console.log(
                "[DISCORD] Slash commands registered"
            );

            for (
                const guild
                of client.guilds.cache.values()
            ) {

                await updateLeaderboard(
                    guild
                ).catch(() => {});
            }

            setInterval(
                async () => {

                    for (
                        const guild
                        of client.guilds.cache.values()
                    ) {

                        await updateLeaderboard(
                            guild
                        ).catch(
                            error => {
                                console.error(
                                    "[LEADERBOARD ERROR]",
                                    error.message
                                );
                            }
                        );
                    }

                },
                30 * 60 * 1000
            );

        } catch (error) {

            console.error(
                "[READY ERROR]",
                error
            );
        }
    }
);


/* =========================================================
   LOGIN
========================================================= */

client.login(
    TOKEN
).catch(
    error => {

        console.error(
            "[DISCORD LOGIN ERROR]",
            error
        );

        process.exit(1);
    }
);
