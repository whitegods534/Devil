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
const RAINBOW_ROLE_ID = "1551984321395429416";

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
        GatewayIntentBits.Guilds
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
    return Boolean(member?.roles?.cache?.has(roleId));
}

function isSupport(member) {
    return hasRole(member, SUPPORT_ROLE_ID);
}

async function getTicketConfig(guildId) {
    const result = await query(
        `SELECT * FROM ticket_config WHERE guild_id = $1`,
        [guildId]
    );

    return result.rows[0] || null;
}

function isManagement(member, config) {
    if (!config) return false;

    return hasRole(member, config.management_role_id);
}

function isFinancialOperations(member) {
    return hasRole(member, FINANCIAL_OPERATIONS_ROLE_ID);
}

function canManageTickets(member, config) {
    return isSupport(member) || isManagement(member, config);
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
        console.error("[ROBLOX USER ERROR]", error.message);
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

        return response.data?.data?.[0]?.imageUrl || null;
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
   AUTHORIZATION HELPERS
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
        `SELECT rban FROM authorizations WHERE roblox_user_id = $1`,
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
            authorized ? "AUTHORIZED" : "UNAUTHORIZED",
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

function successEmbed(title, description, color = "green") {
    return new EmbedBuilder()
        .setTitle(`✅ ${title}`)
        .setDescription(description)
        .setColor(getColor(color));
}

function errorEmbed(title, description, color = "red") {
    return new EmbedBuilder()
        .setTitle(`❌ ${title}`)
        .setDescription(description)
        .setColor(getColor(color));
}

/* =========================================================
   TICKET EMBED
========================================================= */

function ticketEmbed(config, ticket, opener) {
    const color = getColor(config?.ticket_color || "blue");

    let status = ticket.status?.toUpperCase() || "OPEN";

    if (ticket.status === "escalated") {
        status = "ESCALATED";
    }

    const embed = new EmbedBuilder()
        .setTitle("🎫 Support Ticket")
        .setDescription(
            `Welcome <@${ticket.opener_id}>.\n\n` +
            `Please explain what you need help with and a member of staff will assist you.`
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
        .setColor(color)
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
        embed.setThumbnail(opener.displayAvatarURL());
    }

    return embed;
}

function ticketButtons() {
    return new ActionRowBuilder().addComponents(
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

/* =========================================================
   TICKET LOGGING
========================================================= */

async function logTicket(guild, config, title, description, color = "blue") {
    if (!config?.log_channel_id) return;

    const channel = guild.channels.cache.get(config.log_channel_id);

    if (!channel) return;

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

async function addClaim(guildId, userId, userTag) {
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

async function wipeClaims(guildId, userId) {
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
    const config = await getTicketConfig(guild.id);

    if (!config) return;

    const channel = guild.channels.cache.get(
        LEADERBOARD_CHANNEL_ID
    );

    if (!channel) {
        console.log(
            `[LEADERBOARD] Channel ${LEADERBOARD_CHANNEL_ID} not found in ${guild.name}`
        );
        return;
    }

    const result = await query(
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
        description = "No ticket claims have been recorded yet.";
    } else {
        description = rows
            .map((row, index) => {
                const position = index + 1;

                let medal = `${position}.`;

                if (position === 1) medal = "🥇";
                if (position === 2) medal = "🥈";
                if (position === 3) medal = "🥉";

                return `${medal} <@${row.user_id}> — **${row.count} claims**`;
            })
            .join("\n");
    }

    const embed = new EmbedBuilder()
        .setTitle("🏆 Ticket Leaderboard")
        .setDescription(description)
        .addFields({
            name: "Updates",
            value: "Automatically updated every 30 minutes.",
            inline: false
        })
        .setColor(getColor(config.leaderboard_color || "purple"))
        .setFooter({
            text: "Devil Support"
        })
        .setTimestamp();

    let message = null;

    if (config.leaderboard_message_id) {
        message = await channel.messages.fetch(
            config.leaderboard_message_id
        ).catch(() => null);
    }

    if (message) {
        await message.edit({
            embeds: [embed]
        }).catch(() => {});
    } else {
        const newMessage = await channel.send({
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
   RAINBOW ROLE
========================================================= */

let rainbowHue = 0;

function hsvToRgb(h, s, v) {
    h = h % 360;

    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;

    let r = 0;
    let g = 0;
    let b = 0;

    if (h < 60) {
        r = c;
        g = x;
    } else if (h < 120) {
        r = x;
        g = c;
    } else if (h < 180) {
        g = c;
        b = x;
    } else if (h < 240) {
        g = x;
        b = c;
    } else if (h < 300) {
        r = x;
        b = c;
    } else {
        r = c;
        b = x;
    }

    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
    };
}

function startRainbowRole() {
    console.log("[RAINBOW] Fast rainbow animation started.");

    setInterval(async () => {
        try {
            rainbowHue += 10;

            if (rainbowHue >= 360) {
                rainbowHue = 0;
            }

            const rgb = hsvToRgb(rainbowHue, 1, 1);

            const color =
                (rgb.r << 16) |
                (rgb.g << 8) |
                rgb.b;

            for (const guild of client.guilds.cache.values()) {
                const role = guild.roles.cache.get(RAINBOW_ROLE_ID);

                if (!role || role.id === guild.id) continue;

                await role.setColor(
                    color,
                    "Fast rainbow role animation"
                ).catch(() => {});
            }
        } catch (error) {
            console.error("[RAINBOW ERROR]", error.message);
        }
    }, 1000);
}

/* =========================================================
   SLASH COMMANDS
========================================================= */

const commands = [

    new SlashCommandBuilder()
        .setName("cmdshelp")
        .setDescription("View all Devil bot commands and what they do"),


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
                        .setName("management_role")
                        .setDescription("Management role")
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName("category")
                        .setDescription("Ticket category")
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName("log_channel")
                        .setDescription("Ticket log channel")
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("panel_color")
                        .setDescription("Panel colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(color => ({
                                name: color,
                                value: color
                            }))
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("ticket_color")
                        .setDescription("Ticket colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(color => ({
                                name: color,
                                value: color
                            }))
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("success_color")
                        .setDescription("Success colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(color => ({
                                name: color,
                                value: color
                            }))
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("error_color")
                        .setDescription("Error colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(color => ({
                                name: color,
                                value: color
                            }))
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("leaderboard_color")
                        .setDescription("Leaderboard colour")
                        .setRequired(true)
                        .addChoices(
                            ...Object.keys(COLORS).map(color => ({
                                name: color,
                                value: color
                            }))
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
                .setName("rename")
                .setDescription("Rename this ticket")
                .addStringOption(option =>
                    option
                        .setName("name")
                        .setDescription("New channel name")
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
   REGISTER COMMANDS
========================================================= */

client.once("clientReady", async () => {
    console.log(`[DISCORD] Logged in as ${client.user.tag}`);
        startRainbowRole();

    try {
        await setupDatabase();

        await client.application.commands.set(commands);

        console.log("[DISCORD] Commands registered");
        console.log(`[DISCORD] Badge ID: ${BADGE_ID}`);

        setInterval(async () => {
            for (const guild of client.guilds.cache.values()) {
                await updateLeaderboard(guild).catch(error => {
                    console.error(
                        "[LEADERBOARD ERROR]",
                        error.message
                    );
                });
            }
        }, 30 * 60 * 1000);

        for (const guild of client.guilds.cache.values()) {
            await updateLeaderboard(guild).catch(() => {});
        }

    } catch (error) {
        console.error("[READY ERROR]", error);
    }
});

/* =========================================================
   INTERACTIONS
========================================================= */

client.on("interactionCreate", async interaction => {

    try {

        /* ================================================
           BUTTONS
        ================================================ */

        if (interaction.isButton()) {

            // ticket_create is handled by the dedicated ticket creation handler below.
            if (interaction.customId === "ticket_create") return;

            const guild = interaction.guild;

            if (!guild) return;

            const config = await getTicketConfig(guild.id);

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

            const ticketResult = await query(
                `SELECT * FROM tickets WHERE channel_id = $1`,
                [interaction.channel.id]
            );

            const ticket = ticketResult.rows[0];

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

            /* CLAIM */

            if (interaction.customId === "ticket_claim") {

                if (!canManageTickets(interaction.member, config)) {
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

                if (ticket.status === "closed") {
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

                if (ticket.claimer_id === interaction.user.id) {
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
                    SET claimer_id = $1,
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

                await interaction.channel.permissionOverwrites.edit(
                    interaction.user.id,
                    {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    }
                ).catch(() => {});

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

                await updateLeaderboard(guild);

                return;
            }

            /* ESCALATE */

            if (interaction.customId === "ticket_escalate") {

                if (!canManageTickets(interaction.member, config)) {
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
                    SET status = 'escalated',
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
                    content: `<@&${MANAGER_ROLE_ID}>`,
                    embeds: [
                        new EmbedBuilder()
                            .setTitle("⚠️ Ticket Escalated")
                            .setDescription(
                                `${interaction.user} has escalated this ticket to the Moderator team.`
                            )
                            .setColor(getColor("orange"))
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

            /* CLOSE */

            if (interaction.customId === "ticket_close") {

                if (!canManageTickets(interaction.member, config)) {
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
                    SET status = 'closed',
                        closed_at = NOW()
                    WHERE channel_id = $1
                    `,
                    [interaction.channel.id]
                );

                await interaction.reply({
                    embeds: [
                        successEmbed(
                            "Ticket Closed",
                            "This ticket will be deleted in 5 seconds.",
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

                setTimeout(async () => {
                    await interaction.channel.delete().catch(() => {});
                }, 5000);

                return;
            }
        }

        /* ================================================
           SLASH COMMANDS
        ================================================ */

        if (!interaction.isChatInputCommand()) return;

        const guild = interaction.guild;

        if (!guild) {
            return interaction.reply({
                content: "This command can only be used inside a server.",
                ephemeral: true
            });
        }


        if (interaction.commandName === "cmdshelp") {

            const embed = new EmbedBuilder()
                .setTitle("📖 Devil Bot Commands")
                .setDescription("Here are all available commands and what they do.")
                .addFields(
                    {
                        name: "🔐 Authorization",
                        value:
                            "`/auth <username>` — Authorize a Roblox user.\n" +
                            "`/check <username>` — Check whether a Roblox user is authorized.\n" +
                            "`/profile <username>` — View a Roblox user's profile information.\n" +
                            "`/history <username>` — View authorization history for a Roblox user.",
                        inline: false
                    },
                    {
                        name: "🎫 Tickets",
                        value:
                            "`/ticket setup` — Configure the ticket system.\n" +
                            "`/ticket panel` — Send the ticket creation panel.\n" +
                            "`/ticket claim` — Claim the current ticket.\n" +
                            "`/ticket close` — Close the current ticket.\n" +
                            "`/ticket rename <name>` — Rename the current ticket.\n" +
                            "`/ticket add <user>` — Add a user to the current ticket.\n" +
                            "`/ticket remove <user>` — Remove a user from the current ticket.\n" +
                            "`/escalate` — Escalate the current ticket to the Moderator team.",
                        inline: false
                    },
                    {
                        name: "📊 Staff",
                        value:
                            "`/stats` — View ticket statistics.\n" +
                            "`/wipetickets <user>` — Wipe a user's ticket claim statistics.",
                        inline: false
                    }
                )
                .setColor(getColor("blue"))
                .setFooter({
                    text: "Devil Support System"
                })
                .setTimestamp();

            return interaction.reply({
                embeds: [embed],
                ephemeral: true
            });
        }

        /* ================================================
           AUTH
        ================================================ */

        if (interaction.commandName === "auth") {

            if (!isFinancialOperations(interaction.member)) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "No Permission",
                            "You need Financial Operations to use this command."
                        )
                    ],
                    ephemeral: true
                });
            }

            const username =
                interaction.options.getString("username", true);

            const user = await getRobloxUser(username);

            if (!user) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "User Not Found",
                            `I could not find the Roblox user \`${username}\`.`
                        )
                    ],
                    ephemeral: true
                });
            }

            const result = await saveAuthorization({
                robloxUsername: user.name,
                robloxUserId: user.id,
                discordUserId: interaction.user.id,
                source: "discord",
                authorizedBy: interaction.user.id
            });

            if (!result.success) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "Blocked",
                            "This Roblox user is rBanned and cannot be authorized."
                        )
                    ],
                    ephemeral: true
                });
            }

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "User Authorized",
                        `**${user.name}** has been authorized.\n\nRoblox ID: \`${user.id}\``,
                        "green"
                    )
                ]
            });
        }

        /* ================================================
           CHECK
        ================================================ */

        if (interaction.commandName === "check") {

            const config = await getTicketConfig(guild.id);

            if (
                !isFinancialOperations(interaction.member) &&
                !isSupport(interaction.member) &&
                !isManagement(interaction.member, config)
            ) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "No Permission",
                            "You do not have permission to use this command."
                        )
                    ],
                    ephemeral: true
                });
            }

            const username =
                interaction.options.getString("username", true);

            const user = await getRobloxUser(username);

            if (!user) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "User Not Found",
                            `I could not find \`${username}\`.`
                        )
                    ],
                    ephemeral: true
                });
            }

            const result = await query(
                `
                SELECT *
                FROM authorizations
                WHERE roblox_user_id = $1
                `,
                [user.id]
            );

            const auth = result.rows[0];

            if (!auth) {
                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle("🔎 Authorization Check")
                            .setDescription(
                                `**${user.name}** is not authorized.`
                            )
                            .setColor(getColor("red"))
                    ]
                });
            }

            if (auth.rban) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "rBanned",
                            `**${user.name}** is rBanned and blocked from authorization.`
                        )
                    ]
                });
            }

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🔎 Authorization Check")
                        .addFields(
                            {
                                name: "Roblox User",
                                value: user.name,
                                inline: true
                            },
                            {
                                name: "Roblox ID",
                                value: String(user.id),
                                inline: true
                            },
                            {
                                name: "Status",
                                value: auth.authorized
                                    ? "🟢 Authorized"
                                    : "🔴 Not Authorized",
                                inline: true
                            },
                            {
                                name: "Source",
                                value: auth.authorization_source || "Unknown",
                                inline: true
                            }
                        )
                        .setColor(
                            auth.authorized
                                ? getColor("green")
                                : getColor("red")
                        )
                ]
            });
        }

        /* ================================================
           PROFILE
        ================================================ */

        if (interaction.commandName === "profile") {

            const config = await getTicketConfig(guild.id);

            if (
                !isFinancialOperations(interaction.member) &&
                !isSupport(interaction.member) &&
                !isManagement(interaction.member, config)
            ) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "No Permission",
                            "You do not have permission to use this command."
                        )
                    ],
                    ephemeral: true
                });
            }

            const username =
                interaction.options.getString("username", true);

            const user = await getRobloxUser(username);

            if (!user) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "User Not Found",
                            `I could not find \`${username}\`.`
                        )
                    ],
                    ephemeral: true
                });
            }

            const profile = await getRobloxProfile(user.id);

            if (!profile) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "Error",
                            "I could not retrieve this Roblox profile."
                        )
                    ],
                    ephemeral: true
                });
            }

            const avatar = await getRobloxAvatar(user.id);
            const social = await getRobloxFollowers(user.id);

            const embed = new EmbedBuilder()
                .setTitle(`👤 ${profile.name}`)
                .setDescription(
                    profile.description ||
                    "This user has no profile description."
                )
                .addFields(
                    {
                        name: "Username",
                        value: profile.name,
                        inline: true
                    },
                    {
                        name: "Display Name",
                        value: profile.displayName,
                        inline: true
                    },
                    {
                        name: "Roblox ID",
                        value: String(profile.id),
                        inline: true
                    },
                    {
                        name: "Followers",
                        value: String(social.followers),
                        inline: true
                    },
                    {
                        name: "Following",
                        value: String(social.following),
                        inline: true
                    },
                    {
                        name: "Created",
                        value: `<t:${Math.floor(
                            new Date(profile.created).getTime() / 1000
                        )}:D>`,
                        inline: true
                    }
                )
                .setColor(getColor("blue"))
                .setTimestamp();

            if (avatar) {
                embed.setThumbnail(avatar);
            }

            return interaction.reply({
                embeds: [embed]
            });
        }

        /* ================================================
           HISTORY
        ================================================ */

        if (interaction.commandName === "history") {

            const config = await getTicketConfig(guild.id);

            if (
                !isFinancialOperations(interaction.member) &&
                !isSupport(interaction.member) &&
                !isManagement(interaction.member, config)
            ) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "No Permission",
                            "You do not have permission to use this command."
                        )
                    ],
                    ephemeral: true
                });
            }

            const username =
                interaction.options.getString("username", true);

            const user = await getRobloxUser(username);

            if (!user) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "User Not Found",
                            `I could not find \`${username}\`.`
                        )
                    ],
                    ephemeral: true
                });
            }

            const result = await query(
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
                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle("📜 Authorization History")
                            .setDescription(
                                `No authorization history exists for **${user.name}**.`
                            )
                            .setColor(getColor("dark"))
                    ]
                });
            }

            const description = result.rows
                .map(row => {
                    const timestamp = Math.floor(
                        new Date(row.created_at).getTime() / 1000
                    );

                    return (
                        `**${row.action}** — ${row.source || "unknown"}\n` +
                        `Staff: <@${row.staff_user_id}> • <t:${timestamp}:R>`
                    );
                })
                .join("\n\n");

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(`📜 History — ${user.name}`)
                        .setDescription(description)
                        .setColor(getColor("purple"))
                ]
            });
        }

        /* ================================================
           STATS
        ================================================ */

        if (interaction.commandName === "stats") {

            const config = await getTicketConfig(guild.id);

            if (!canManageTickets(interaction.member, config)) {
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

            const open = await query(
                `
                SELECT COUNT(*) AS count
                FROM tickets
                WHERE guild_id = $1
                AND status != 'closed'
                `,
                [guild.id]
            );

            const closed = await query(
                `
                SELECT COUNT(*) AS count
                FROM tickets
                WHERE guild_id = $1
                AND status = 'closed'
                `,
                [guild.id]
            );

            const claims = await query(
                `
                SELECT COALESCE(SUM(count),0) AS count
                FROM ticket_claims
                WHERE guild_id = $1
                `,
                [guild.id]
            );

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("📊 Ticket Statistics")
                        .addFields(
                            {
                                name: "Open Tickets",
                                value: String(open.rows[0].count),
                                inline: true
                            },
                            {
                                name: "Closed Tickets",
                                value: String(closed.rows[0].count),
                                inline: true
                            },
                            {
                                name: "Total Claims",
                                value: String(claims.rows[0].count),
                                inline: true
                            }
                        )
                        .setColor(getColor("blue"))
                        .setTimestamp()
                ]
            });
        }

        /* ================================================
           WIPE TICKETS
        ================================================ */

        if (interaction.commandName === "wipetickets") {

            if (!isFinancialOperations(interaction.member)) {
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
                interaction.options.getUser("user", true);

            await wipeClaims(
                guild.id,
                user.id
            );

            await updateLeaderboard(guild);

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "Claims Wiped",
                        `All ticket claim statistics for ${user} have been wiped.`
                    )
                ]
            });
        }

        /* ================================================
           ESCALATE
        ================================================ */

/* ESCALATE */

if (interaction.customId === "ticket_escalate") {

    if (!canManageTickets(interaction.member, config)) {
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

    // Move ticket into the escalated category.
    // This automatically removes it from its current category.
    try {
        await interaction.channel.setParent(
            "1549118580279214160",
            {
                lockPermissions: false
            }
        );
    } catch (error) {
        console.error("[ESCALATE CATEGORY ERROR]", error);

        return interaction.reply({
            embeds: [
                errorEmbed(
                    "Escalation Failed",
                    "I could not move this ticket into the escalated category. Make sure the bot has Manage Channels permission."
                )
            ],
            ephemeral: true
        });
    }

    // Update database
    await query(
        `
        UPDATE tickets
        SET status = 'escalated',
            escalated_by = $1,
            escalated_at = NOW()
        WHERE channel_id = $2
        `,
        [
            interaction.user.id,
            interaction.channel.id
        ]
    );

    // Send escalation message
    await interaction.reply({
        content: `<@&${MANAGER_ROLE_ID}>`,
        embeds: [
            new EmbedBuilder()
                .setTitle("⚠️ Ticket Escalated")
                .setDescription(
                    `${interaction.user} has escalated this ticket to the Moderator team.\n\n` +
                    `This ticket has been moved to the escalated category.`
                )
                .setColor(getColor("orange"))
                .setTimestamp()
        ]
    });

    // Log escalation
    await logTicket(
        guild,
        config,
        "Ticket Escalated",
        `${interaction.user} escalated ${interaction.channel} to <@&${MANAGER_ROLE_ID}>.`,
        "orange"
    );

    return;
}

        /* ================================================
           TICKET COMMAND
        ================================================ */

        if (interaction.commandName === "ticket") {

            const subcommand =
                interaction.options.getSubcommand();

            /* SETUP */

            if (subcommand === "setup") {

                if (!isFinancialOperations(interaction.member)) {
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

                const managementRole =
                    interaction.options.getRole("management_role", true);

                const category =
                    interaction.options.getChannel("category", true);

                const logChannel =
                    interaction.options.getChannel("log_channel", true);

                const panelColor =
                    interaction.options.getString("panel_color", true);

                const ticketColor =
                    interaction.options.getString("ticket_color", true);

                const successColor =
                    interaction.options.getString("success_color", true);

                const errorColor =
                    interaction.options.getString("error_color", true);

                const leaderboardColor =
                    interaction.options.getString(
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
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    ON CONFLICT (guild_id)
                    DO UPDATE SET
                        support_role_id = EXCLUDED.support_role_id,
                        management_role_id = EXCLUDED.management_role_id,
                        category_id = EXCLUDED.category_id,
                        log_channel_id = EXCLUDED.log_channel_id,
                        panel_channel_id = EXCLUDED.panel_channel_id,
                        panel_color = EXCLUDED.panel_color,
                        ticket_color = EXCLUDED.ticket_color,
                        success_color = EXCLUDED.success_color,
                        error_color = EXCLUDED.error_color,
                        leaderboard_color = EXCLUDED.leaderboard_color
                    `,
                    [
                        guild.id,
                        SUPPORT_ROLE_ID,
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

                const panel = new EmbedBuilder()
                    .setTitle("🎫 Devil Support")
                    .setDescription(
                        "Need help? Open a ticket below and our support team will assist you.\n\n" +
                        "Please provide as much information as possible when opening your ticket."
                    )
                    .addFields({
                        name: "Support",
                        value: `<@&${SUPPORT_ROLE_ID}>`,
                        inline: true
                    })
                    .setColor(getColor(panelColor))
                    .setFooter({
                        text: "Devil Support System"
                    });

                const buttons =
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("ticket_create")
                            .setLabel("Create Ticket")
                            .setEmoji("🎫")
                            .setStyle(ButtonStyle.Primary)
                    );

                const message = await interaction.channel.send({
                    embeds: [panel],
                    components: [buttons]
                });

                await query(
                    `
                    UPDATE ticket_config
                    SET panel_message_id = $1
                    WHERE guild_id = $2
                    `,
                    [
                        message.id,
                        guild.id
                    ]
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

                await updateLeaderboard(guild);

                return;
            }

            /* PANEL */

            if (subcommand === "panel") {

                const config = await getTicketConfig(guild.id);

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
                    !isFinancialOperations(interaction.member) &&
                    !isSupport(interaction.member)
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

                const panel = new EmbedBuilder()
                    .setTitle("🎫 Devil Support")
                    .setDescription(
                        "Need help? Open a ticket below and our support team will assist you."
                    )
                    .addFields({
                        name: "Support",
                        value: `<@&${SUPPORT_ROLE_ID}>`,
                        inline: true
                    })
                    .setColor(
                        getColor(config.panel_color)
                    )
                    .setFooter({
                        text: "Devil Support System"
                    });

                const buttons =
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("ticket_create")
                            .setLabel("Create Ticket")
                            .setEmoji("🎫")
                            .setStyle(ButtonStyle.Primary)
                    );

                const message = await interaction.channel.send({
                    embeds: [panel],
                    components: [buttons]
                });

                await query(
                    `
                    UPDATE ticket_config
                    SET panel_channel_id = $1,
                        panel_message_id = $2
                    WHERE guild_id = $3
                    `,
                    [
                        interaction.channel.id,
                        message.id,
                        guild.id
                    ]
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

            /* EVERYTHING BELOW THIS POINT IS TICKET-ONLY */

            const ticketResult = await query(
                `SELECT * FROM tickets WHERE channel_id = $1`,
                [interaction.channel.id]
            );

            const ticket = ticketResult.rows[0];

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

            const config = await getTicketConfig(guild.id);

            /* CLAIM */

            if (subcommand === "claim") {

                if (!canManageTickets(interaction.member, config)) {
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

                await query(
                    `
                    UPDATE tickets
                    SET claimer_id = $1,
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
                            `${interaction.user} has claimed this ticket.`,
                            config.success_color
                        )
                    ]
                });

                await updateLeaderboard(guild);

                return;
            }

            /* CLOSE */

            if (subcommand === "close") {

                if (!canManageTickets(interaction.member, config)) {
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
                    SET status = 'closed',
                        closed_at = NOW()
                    WHERE channel_id = $1
                    `,
                    [interaction.channel.id]
                );

                await interaction.reply({
                    embeds: [
                        successEmbed(
                            "Ticket Closed",
                            "This ticket will be deleted in 5 seconds.",
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

                setTimeout(async () => {
                    await interaction.channel.delete().catch(() => {});
                }, 5000);

                return;
            }

            /* RENAME */

            if (subcommand === "rename") {

                if (!isSupport(interaction.member)) {
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
                    interaction.options.getString("name", true);

                const safeName = name
                    .toLowerCase()
                    .replace(/[^a-z0-9-_]/g, "-")
                    .slice(0, 90);

                await interaction.channel.setName(
                    safeName
                );

                return interaction.reply({
                    embeds: [
                        successEmbed(
                            "Ticket Renamed",
                            `Ticket renamed to **${safeName}**.`
                        )
                    ]
                });
            }

            /* ADD */

            if (subcommand === "add") {

                if (!isSupport(interaction.member)) {
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
                    interaction.options.getUser("user", true);

                await interaction.channel.permissionOverwrites.edit(
                    user.id,
                    {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true,
                        AttachFiles: true,
                        EmbedLinks: true
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

            /* REMOVE */

            if (subcommand === "remove") {

                if (!isSupport(interaction.member)) {
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
                    interaction.options.getUser("user", true);

                if (user.id === ticket.opener_id) {
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

                await interaction.channel.permissionOverwrites.delete(
                    user.id
                ).catch(() => {});

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

        console.error("[INTERACTION ERROR]", error);

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                embeds: [
                    errorEmbed(
                        "Error",
                        "Something went wrong while processing that request."
                    )
                ],
                ephemeral: true
            }).catch(() => {});
        } else {
            await interaction.reply({
                embeds: [
                    errorEmbed(
                        "Error",
                        "Something went wrong while processing that request."
                    )
                ],
                ephemeral: true
            }).catch(() => {});
        }
    }
});

/* =========================================================
   TICKET CREATE BUTTON
========================================================= */

client.on("interactionCreate", async interaction => {

    if (!interaction.isButton()) return;

    if (interaction.customId !== "ticket_create") return;

    try {

        const guild = interaction.guild;

        if (!guild) return;

        const config = await getTicketConfig(guild.id);

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

        const existing = await query(
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
            const existingChannel =
                guild.channels.cache.get(
                    existing.rows[0].channel_id
                );

            if (existingChannel) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "Ticket Already Open",
                            `You already have a ticket: ${existingChannel}`
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
                [existing.rows[0].channel_id]
            );
        }

        const channel = await guild.channels.create({
            name: `ticket-${interaction.user.username}`
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, "-")
                .slice(0, 90),

            type: ChannelType.GuildText,

            parent: config.category_id,

            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
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
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                },
                {
                    id: SUPPORT_ROLE_ID,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
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

        const ticketResult = await query(
            `
            SELECT *
            FROM tickets
            WHERE channel_id = $1
            `,
            [channel.id]
        );

        const ticket = ticketResult.rows[0];

        await channel.send({
            content:
                `<@${interaction.user.id}> <@&${SUPPORT_ROLE_ID}>`,
            embeds: [
                ticketEmbed(
                    config,
                    ticket,
                    interaction.member
                )
            ],
            components: [
                ticketButtons()
            ]
        });

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

        await logTicket(
            guild,
            config,
            "Ticket Created",
            `${interaction.user} created ${channel}.`,
            config.success_color
        );

    } catch (error) {

        console.error(
            "[TICKET CREATE ERROR]",
            error
        );

        if (!interaction.replied) {
            await interaction.reply({
                embeds: [
                    errorEmbed(
                        "Error",
                        "I could not create your ticket."
                    )
                ],
                ephemeral: true
            }).catch(() => {});
        }
    }
});

/* =========================================================
   EXPRESS API
========================================================= */

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        status: "online",
        bot: client.user?.tag || "starting",
        badgeId: BADGE_ID
    });
});

/* =========================================================
   API AUTH
========================================================= */

function checkApiSecret(req, res, next) {

    const authHeader =
        req.headers.authorization || "";

    const expected =
        `Bearer ${API_SECRET}`;

    if (authHeader !== expected) {
        return res.status(401).json({
            success: false,
            error: "Unauthorized"
        });
    }

    next();
}

/* =========================================================
   ROBLOX CHECK API
========================================================= */

app.get(
    "/check",
    checkApiSecret,
    async (req, res) => {

        try {

            const username =
                req.query.username;

            const userId =
                req.query.userId;

            let robloxUserId = userId;

            if (!robloxUserId && username) {

                const user =
                    await getRobloxUser(username);

                if (!user) {
                    return res.status(404).json({
                        success: false,
                        error: "Roblox user not found"
                    });
                }

                robloxUserId = user.id;
            }

            if (!robloxUserId) {
                return res.status(400).json({
                    success: false,
                    error: "username or userId required"
                });
            }

            const result = await query(
                `
                SELECT *
                FROM authorizations
                WHERE roblox_user_id = $1
                `,
                [robloxUserId]
            );

            if (!result.rows.length) {
                return res.json({
                    success: true,
                    authorized: false,
                    rban: false
                });
            }

            const auth =
                result.rows[0];

            return res.json({
                success: true,
                authorized:
                    auth.authorized && !auth.rban,
                rban: auth.rban,
                username:
                    auth.roblox_username,
                source:
                    auth.authorization_source
            });

        } catch (error) {

            console.error(
                "[API CHECK ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "Internal server error"
            });
        }
    }
);

/* =========================================================
   BADGE AUTHORIZE API
========================================================= */

app.post(
    "/badge-authorize",
    checkApiSecret,
    async (req, res) => {

        try {

            const {
                robloxUsername,
                robloxUserId
            } = req.body;

            if (!robloxUsername || !robloxUserId) {
                return res.status(400).json({
                    success: false,
                    error:
                        "robloxUsername and robloxUserId required"
                });
            }

            const result = await saveAuthorization({
                robloxUsername,
                robloxUserId,
                discordUserId: "ROBLOX_BADGE",
                source: "badge",
                authorizedBy: "Roblox Badge"
            });

            if (!result.success) {
                return res.status(403).json({
                    success: false,
                    authorized: false,
                    reason: result.reason
                });
            }

            return res.json({
                success: true,
                authorized: true,
                username: robloxUsername,
                userId: robloxUserId,
                badgeId: BADGE_ID
            });

        } catch (error) {

            console.error(
                "[BADGE API ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "Internal server error"
            });
        }
    }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
    console.log(`[API] Running on port ${PORT}`);
});

/* =========================================================
   LOGIN
========================================================= */

client.login(TOKEN);
