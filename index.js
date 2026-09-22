// ============================================================
//                  DEADSIGNAL AUTH BOT
//                    TICKET SYSTEM
//                       PART 1/2
// ============================================================

const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionsBitField,
    ChannelType,
    SlashCommandBuilder
} = require("discord.js");

const express = require("express");
const { Pool } = require("pg");

// ============================================================
// CONFIG
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const API_SECRET = process.env.API_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const PORT = process.env.PORT || 8080;

const BADGE_ID = "1761374138287057";

const SUPPORT_ROLE_ID = "1548329037884297229";
const MANAGER_ROLE_ID = "1550551297642729552";
const FINANCIAL_OPERATIONS_ROLE_ID = "1551601781843497";

const LEADERBOARD_CHANNEL_ID = "1551976849385586759";

const FEEDBACK_CHANNEL_ID = "1551996605719380128";

// ============================================================
// CLIENT
// ============================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [
        Partials.Channel
    ]
});

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        online: true,
        service: "DeadSignal Auth",
        status: "online"
    });
});

// ============================================================
// DATABASE
// ============================================================

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// ============================================================
// MEMORY
// ============================================================

const pendingFeedback = new Map();
const pendingCloseChoice = new Map();
const pendingTransferRequests = new Map();

// ============================================================
// COLORS
// ============================================================

const COLORS = {
    blue: 0x3498DB,
    purple: 0x9B59B6,
    green: 0x2ECC71,
    red: 0xE74C3C,
    orange: 0xE67E22,
    pink: 0xFF69B4,
    cyan: 0x1ABC9C,
    dark: 0x2B2D31
};

// ============================================================
// DATABASE SETUP
// ============================================================

async function setupDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS authorizations (
            roblox_username TEXT PRIMARY KEY,
            roblox_user_id TEXT,
            authorized BOOLEAN NOT NULL DEFAULT FALSE,
            rban BOOLEAN NOT NULL DEFAULT FALSE,
            premium BOOLEAN NOT NULL DEFAULT FALSE,
            authorization_source TEXT,
            authorized_by TEXT,
            authorized_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS authorization_history (
            id SERIAL PRIMARY KEY,
            roblox_username TEXT,
            roblox_user_id TEXT,
            action TEXT,
            source TEXT,
            performed_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_config (
            guild_id TEXT PRIMARY KEY,
            support_role_id TEXT,
            management_role_id TEXT,
            category_id TEXT,
            log_channel_id TEXT,
            panel_channel_id TEXT,
            panel_message_id TEXT,

            panel_color INTEGER DEFAULT 3447003,
            ticket_color INTEGER DEFAULT 3447003,
            success_color INTEGER DEFAULT 3066993,
            error_color INTEGER DEFAULT 15158332,
            leaderboard_color INTEGER DEFAULT 10181046,

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tickets (
            channel_id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            opener_id TEXT NOT NULL,
            opener_tag TEXT,

            claimer_id TEXT,
            status TEXT NOT NULL DEFAULT 'open',

            category TEXT DEFAULT 'General',
            tags TEXT[] DEFAULT ARRAY[]::TEXT[],

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            claimed_at TIMESTAMPTZ,
            closed_at TIMESTAMPTZ,

            escalated_by TEXT,
            escalated_at TIMESTAMPTZ,

            close_reason TEXT,
            closed_by TEXT,

            transferred_from TEXT,
            transferred_at TIMESTAMPTZ
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_claims (
            id SERIAL PRIMARY KEY,
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_feedback (
            id SERIAL PRIMARY KEY,
            channel_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            staff_id TEXT,
            rating INTEGER,
            feedback TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_notes (
            id SERIAL PRIMARY KEY,
            channel_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            author_tag TEXT,
            note TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_history (
            id SERIAL PRIMARY KEY,
            channel_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            actor_id TEXT,
            actor_tag TEXT,
            action TEXT NOT NULL,
            details TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_join_requests (
            id SERIAL PRIMARY KEY,
            channel_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            user_tag TEXT,
            reason TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            decided_by TEXT,
            decided_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_joiners (
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(channel_id, user_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_transfer_requests (
            id SERIAL PRIMARY KEY,
            channel_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            from_user_id TEXT NOT NULL,
            target_user_id TEXT NOT NULL,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            decided_at TIMESTAMPTZ,
            decided_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_checklists (
            channel_id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,

            customer_identified BOOLEAN DEFAULT FALSE,
            issue_identified BOOLEAN DEFAULT FALSE,
            authorization_checked BOOLEAN DEFAULT FALSE,
            payment_checked BOOLEAN DEFAULT FALSE,
            solution_provided BOOLEAN DEFAULT FALSE,
            customer_confirmed BOOLEAN DEFAULT FALSE,
            ready_to_close BOOLEAN DEFAULT FALSE
        )
    `);

    console.log("[DATABASE] Tables ready.");
}

// ============================================================
// DATABASE HELPERS
// ============================================================

async function db(query, params = []) {
    const result = await pool.query(query, params);
    return result;
}

// ============================================================
// CONFIG HELPERS
// ============================================================

async function getTicketConfig(guildId) {

    const result = await db(
        `SELECT * FROM ticket_config WHERE guild_id = $1`,
        [guildId]
    );

    if (!result.rows.length) {
        return null;
    }

    return result.rows[0];
}

async function saveTicketConfig(guildId, data) {

    await db(`
        INSERT INTO ticket_config (
            guild_id,
            support_role_id,
            management_role_id,
            category_id,
            log_channel_id,
            panel_channel_id,
            panel_message_id,
            panel_color,
            ticket_color,
            success_color,
            error_color,
            leaderboard_color
        )
        VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        )
        ON CONFLICT (guild_id)
        DO UPDATE SET
            support_role_id = EXCLUDED.support_role_id,
            management_role_id = EXCLUDED.management_role_id,
            category_id = EXCLUDED.category_id,
            log_channel_id = EXCLUDED.log_channel_id,
            panel_channel_id = EXCLUDED.panel_channel_id,
            panel_message_id = EXCLUDED.panel_message_id,
            panel_color = EXCLUDED.panel_color,
            ticket_color = EXCLUDED.ticket_color,
            success_color = EXCLUDED.success_color,
            error_color = EXCLUDED.error_color,
            leaderboard_color = EXCLUDED.leaderboard_color
    `, [
        guildId,
        data.support_role_id || null,
        data.management_role_id || null,
        data.category_id || null,
        data.log_channel_id || null,
        data.panel_channel_id || null,
        data.panel_message_id || null,
        data.panel_color || COLORS.blue,
        data.ticket_color || COLORS.blue,
        data.success_color || COLORS.green,
        data.error_color || COLORS.red,
        data.leaderboard_color || COLORS.purple
    ]);
}

// ============================================================
// PERMISSIONS
// ============================================================

function isFinancialOperations(member) {

    if (!member || !member.roles) {
        return false;
    }

    return member.roles.cache.has(
        FINANCIAL_OPERATIONS_ROLE_ID
    );
}

async function isSupport(member) {

    if (!member || !member.guild) {
        return false;
    }

    const config = await getTicketConfig(member.guild.id);

    const roleId =
        config?.support_role_id ||
        SUPPORT_ROLE_ID;

    return member.roles.cache.has(roleId);
}

async function isManagement(member) {

    if (!member || !member.guild) {
        return false;
    }

    const config = await getTicketConfig(member.guild.id);

    if (!config?.management_role_id) {
        return member.roles.cache.has(MANAGER_ROLE_ID);
    }

    return member.roles.cache.has(
        config.management_role_id
    );
}

async function canManageTickets(member) {

    return (
        await isSupport(member) ||
        await isManagement(member)
    );
}

// ============================================================
// EMBEDS
// ============================================================

function getColor(config, type = "ticket") {

    if (!config) {
        return COLORS.blue;
    }

    if (type === "panel") {
        return config.panel_color || COLORS.blue;
    }

    if (type === "success") {
        return config.success_color || COLORS.green;
    }

    if (type === "error") {
        return config.error_color || COLORS.red;
    }

    return config.ticket_color || COLORS.blue;
}

function successEmbed(title, description, config = null) {

    return new EmbedBuilder()
        .setColor(getColor(config, "success"))
        .setTitle(`✅ ${title}`)
        .setDescription(description)
        .setTimestamp();
}

function errorEmbed(title, description, config = null) {

    return new EmbedBuilder()
        .setColor(getColor(config, "error"))
        .setTitle(`❌ ${title}`)
        .setDescription(description)
        .setTimestamp();
}

// ============================================================
// TICKET STATUS
// ============================================================

function getStatusInfo(status) {

    const statuses = {
        open: {
            label: "OPEN",
            emoji: "🟢"
        },

        claimed: {
            label: "CLAIMED",
            emoji: "🔵"
        },

        waiting_customer: {
            label: "WAITING FOR CUSTOMER",
            emoji: "🟡"
        },

        waiting_staff: {
            label: "WAITING FOR STAFF",
            emoji: "🟠"
        },

        escalated: {
            label: "ESCALATED",
            emoji: "🚨"
        },

        resolved: {
            label: "RESOLVED",
            emoji: "🔵"
        },

        closed: {
            label: "CLOSED",
            emoji: "🔴"
        }
    };

    return statuses[status] || statuses.open;
}

// ============================================================
// TICKET TAGS
// ============================================================

const TICKET_TAGS = [
    "AUTHORIZATION",
    "PAYMENT",
    "PURCHASE",
    "BUG",
    "SCRIPT SUPPORT",
    "APPEAL",
    "REPORT",
    "GENERAL",
    "ESCALATED",
    "REFUND"
];

function formatTags(tags) {

    if (!tags || !tags.length) {
        return "None";
    }

    return tags
        .map(tag => `\`${tag}\``)
        .join(" ");
}

// ============================================================
// CHECKLIST
// ============================================================

const CHECKLIST_ITEMS = [
    ["customer_identified", "Customer identified"],
    ["issue_identified", "Issue identified"],
    ["authorization_checked", "Authorization checked"],
    ["payment_checked", "Payment checked"],
    ["solution_provided", "Solution provided"],
    ["customer_confirmed", "Customer confirmed"],
    ["ready_to_close", "Ready to close"]
];

async function ensureChecklist(channelId, guildId) {

    await db(`
        INSERT INTO ticket_checklists (
            channel_id,
            guild_id
        )
        VALUES ($1,$2)
        ON CONFLICT (channel_id)
        DO NOTHING
    `, [
        channelId,
        guildId
    ]);
}

async function getChecklist(channelId) {

    await ensureChecklist(
        channelId,
        ""
    );

    const result = await db(
        `SELECT * FROM ticket_checklists WHERE channel_id = $1`,
        [channelId]
    );

    return result.rows[0] || null;
}

function checklistText(checklist) {

    if (!checklist) {
        return "No checklist data.";
    }

    return CHECKLIST_ITEMS
        .map(([key, label]) => {
            return `${checklist[key] ? "☑️" : "⬜"} ${label}`;
        })
        .join("\n");
}

// ============================================================
// TICKET HISTORY
// ============================================================

async function addTicketHistory(
    channelId,
    guildId,
    actorId,
    actorTag,
    action,
    details = ""
) {

    await db(`
        INSERT INTO ticket_history (
            channel_id,
            guild_id,
            actor_id,
            actor_tag,
            action,
            details
        )
        VALUES ($1,$2,$3,$4,$5,$6)
    `, [
        channelId,
        guildId,
        actorId || null,
        actorTag || null,
        action,
        details || null
    ]);
}

async function getTicketHistory(channelId, limit = 15) {

    const result = await db(`
        SELECT *
        FROM ticket_history
        WHERE channel_id = $1
        ORDER BY created_at DESC
        LIMIT $2
    `, [
        channelId,
        limit
    ]);

    return result.rows;
}

// ============================================================
// STAFF NOTES
// ============================================================

async function addTicketNote(
    channelId,
    guildId,
    authorId,
    authorTag,
    note
) {

    await db(`
        INSERT INTO ticket_notes (
            channel_id,
            guild_id,
            author_id,
            author_tag,
            note
        )
        VALUES ($1,$2,$3,$4,$5)
    `, [
        channelId,
        guildId,
        authorId,
        authorTag,
        note
    ]);

    await addTicketHistory(
        channelId,
        guildId,
        authorId,
        authorTag,
        "NOTE_ADDED",
        note
    );
}

async function getTicketNotes(channelId) {

    const result = await db(`
        SELECT *
        FROM ticket_notes
        WHERE channel_id = $1
        ORDER BY created_at DESC
        LIMIT 25
    `, [
        channelId
    ]);

    return result.rows;
}

// ============================================================
// TICKET LOOKUP
// ============================================================

async function getCurrentTicket(channelId) {

    const result = await db(
        `SELECT * FROM tickets WHERE channel_id = $1`,
        [channelId]
    );

    return result.rows[0] || null;
}

// ============================================================
// CLAIM COUNT
// ============================================================

async function getJoinedStaffCount(channelId) {

    const result = await db(`
        SELECT COUNT(*)::INTEGER AS count
        FROM ticket_joiners
        WHERE channel_id = $1
    `, [
        channelId
    ]);

    return result.rows[0]?.count || 0;
}

// ============================================================
// TICKET CONTROL PANEL
// ============================================================

function ticketControlPanel(ticket, config, checklist = null) {

    const status = getStatusInfo(ticket.status);

    const claimed =
        ticket.claimer_id
            ? `<@${ticket.claimer_id}>`
            : "Nobody";

    const tags = formatTags(ticket.tags);

    const joined =
        ticket.channel_id
            ? "Use Request to Join"
            : "0/1";

    const embed = new EmbedBuilder()
        .setColor(getColor(config, "ticket"))
        .setTitle("🎫 DeadSignal Ticket Control Panel")
        .setDescription(
            "Use the controls below to manage this ticket.\n\n" +
            "Only authorised staff can use the management controls."
        )
        .addFields(
            {
                name: "👤 Client",
                value: `<@${ticket.opener_id}>`,
                inline: true
            },
            {
                name: "👮 Claimed By",
                value: claimed,
                inline: true
            },
            {
                name: "📌 Ticket Status",
                value: `${status.emoji} ${status.label}`,
                inline: true
            },
            {
                name: "🗂️ Ticket Tags",
                value: tags,
                inline: false
            },
            {
                name: "👥 Additional Staff",
                value: `${joined}`,
                inline: true
            },
            {
                name: "🕐 Created",
                value: `<t:${Math.floor(
                    new Date(ticket.created_at).getTime() / 1000
                )}:R>`,
                inline: true
            }
        )
        .setFooter({
            text: "DeadSignal Support • Ticket Control"
        })
        .setTimestamp();

    return embed;
}

// ============================================================
// CONTROL PANEL BUTTONS
// ============================================================

function ticketControlButtons() {

    return [

        new ActionRowBuilder()
            .addComponents(

                new ButtonBuilder()
                    .setCustomId("ticket_claim")
                    .setLabel("Claim")
                    .setEmoji("🙋")
                    .setStyle(ButtonStyle.Primary),

                new ButtonBuilder()
                    .setCustomId("ticket_transfer")
                    .setLabel("Transfer")
                    .setEmoji("🔄")
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setCustomId("ticket_join")
                    .setLabel("Request to Join")
                    .setEmoji("👤")
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setCustomId("ticket_close_panel")
                    .setLabel("Close")
                    .setEmoji("🔴")
                    .setStyle(ButtonStyle.Danger)
            ),

        new ActionRowBuilder()
            .addComponents(

                new ButtonBuilder()
                    .setCustomId("ticket_status")
                    .setLabel("Status")
                    .setEmoji("📌")
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setCustomId("ticket_checklist")
                    .setLabel("Checklist")
                    .setEmoji("☑️")
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setCustomId("ticket_tags")
                    .setLabel("Tags")
                    .setEmoji("🗂️")
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setCustomId("ticket_history")
                    .setLabel("History")
                    .setEmoji("📜")
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setCustomId("ticket_notes")
                    .setLabel("Notes")
                    .setEmoji("📝")
                    .setStyle(ButtonStyle.Secondary)
            )
    ];
}

// ============================================================
// CLOSE PANEL
// ============================================================

function closePanelEmbed() {

    return new EmbedBuilder()
        .setColor(COLORS.red)
        .setTitle("🔴 Close Ticket")
        .setDescription(
            "Select the reason for closing this ticket.\n\n" +

            "**Client is AFK**\n" +
            "The client is unavailable. The ticket will be closed immediately with **no feedback request**.\n\n" +

            "**Handled**\n" +
            "The issue has been handled. The client will receive the feedback request before the ticket is permanently closed."
        )
        .setFooter({
            text: "Staff only"
        });
}

function closePanelButtons() {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId("close_reason_afk")
                .setLabel("Client is AFK")
                .setEmoji("💤")
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId("close_reason_handled")
                .setLabel("Handled")
                .setEmoji("✅")
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId("close_cancel")
                .setLabel("Cancel")
                .setEmoji("✖️")
                .setStyle(ButtonStyle.Danger)
        );
}

// ============================================================
// STATUS PANEL
// ============================================================

function statusPanel() {

    return new ActionRowBuilder()
        .addComponents(

            new StringSelectMenuBuilder()
                .setCustomId("ticket_status_select")
                .setPlaceholder("Select a ticket status")
                .addOptions(
                    {
                        label: "Open",
                        value: "open",
                        emoji: "🟢"
                    },
                    {
                        label: "Claimed",
                        value: "claimed",
                        emoji: "🔵"
                    },
                    {
                        label: "Waiting for Customer",
                        value: "waiting_customer",
                        emoji: "🟡"
                    },
                    {
                        label: "Waiting for Staff",
                        value: "waiting_staff",
                        emoji: "🟠"
                    },
                    {
                        label: "Escalated",
                        value: "escalated",
                        emoji: "🚨"
                    },
                    {
                        label: "Resolved",
                        value: "resolved",
                        emoji: "🔵"
                    }
                )
        );
}

// ============================================================
// TAG PANEL
// ============================================================

function tagPanel() {

    return new ActionRowBuilder()
        .addComponents(

            new StringSelectMenuBuilder()
                .setCustomId("ticket_tag_select")
                .setPlaceholder("Select a ticket tag")
                .setMinValues(0)
                .setMaxValues(3)
                .addOptions(
                    TICKET_TAGS.map(tag => ({
                        label: tag,
                        value: tag.toLowerCase().replace(/ /g, "_")
                    }))
                )
        );
}

// ============================================================
// CHECKLIST PANEL
// ============================================================

function checklistPanel(checklist) {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId("check_customer")
                .setLabel(
                    checklist?.customer_identified
                        ? "Customer ✓"
                        : "Customer"
                )
                .setStyle(
                    checklist?.customer_identified
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
                ),

            new ButtonBuilder()
                .setCustomId("check_issue")
                .setLabel(
                    checklist?.issue_identified
                        ? "Issue ✓"
                        : "Issue"
                )
                .setStyle(
                    checklist?.issue_identified
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
                ),

            new ButtonBuilder()
                .setCustomId("check_auth")
                .setLabel(
                    checklist?.authorization_checked
                        ? "Auth ✓"
                        : "Auth"
                )
                .setStyle(
                    checklist?.authorization_checked
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
                ),

            new ButtonBuilder()
                .setCustomId("check_payment")
                .setLabel(
                    checklist?.payment_checked
                        ? "Payment ✓"
                        : "Payment"
                )
                .setStyle(
                    checklist?.payment_checked
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
                ),

            new ButtonBuilder()
                .setCustomId("check_solution")
                .setLabel(
                    checklist?.solution_provided
                        ? "Solution ✓"
                        : "Solution"
                )
                .setStyle(
                    checklist?.solution_provided
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
                )
        );
}

// ============================================================
// SECOND CHECKLIST ROW
// ============================================================

function checklistPanelTwo(checklist) {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId("check_confirmed")
                .setLabel(
                    checklist?.customer_confirmed
                        ? "Customer Confirmed ✓"
                        : "Customer Confirmed"
                )
                .setStyle(
                    checklist?.customer_confirmed
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
                ),

            new ButtonBuilder()
                .setCustomId("check_ready")
                .setLabel(
                    checklist?.ready_to_close
                        ? "Ready ✓"
                        : "Ready to Close"
                )
                .setStyle(
                    checklist?.ready_to_close
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
                )
        );
}

// ============================================================
// TICKET EMBED
// ============================================================

async function refreshTicketPanel(channel) {

    const ticket = await getCurrentTicket(channel.id);

    if (!ticket) {
        return;
    }

    const config = await getTicketConfig(
        channel.guild.id
    );

    const checklist = await db(`
        SELECT *
        FROM ticket_checklists
        WHERE channel_id = $1
    `, [
        channel.id
    ]);

    const embed = ticketControlPanel(
        ticket,
        config,
        checklist.rows[0]
    );

    const messages = await channel.messages.fetch({
        limit: 20
    });

    const panelMessage = messages.find(
        message =>
            message.author.id === client.user.id &&
            message.embeds.length &&
            message.embeds[0].title ===
                "🎫 DeadSignal Ticket Control Panel"
    );

    if (panelMessage) {

        await panelMessage.edit({
            embeds: [embed],
            components: ticketControlButtons()
        });

    }
}

// ============================================================
// CREATE TICKET
// ============================================================

async function createTicket(guild, user) {

    const config = await getTicketConfig(
        guild.id
    );

    if (!config) {
        throw new Error(
            "Ticket system has not been configured."
        );
    }

    const existing = await db(`
        SELECT *
        FROM tickets
        WHERE guild_id = $1
        AND opener_id = $2
        AND status != 'closed'
        LIMIT 1
    `, [
        guild.id,
        user.id
    ]);

    if (existing.rows.length) {

        return {
            existing: true,
            channelId: existing.rows[0].channel_id
        };
    }

    const channel = await guild.channels.create({
        name: `ticket-${user.username}`.toLowerCase().slice(0, 90),

        type: ChannelType.GuildText,

        parent: config.category_id || null,

        topic:
            `DeadSignal Ticket • ${user.username} • ${user.id}`,

        permissionOverwrites: [

            {
                id: guild.id,
                deny: [
                    PermissionsBitField.Flags.ViewChannel
                ]
            },

            {
                id: user.id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory,
                    PermissionsBitField.Flags.AttachFiles
                ]
            },

            {
                id: config.support_role_id || SUPPORT_ROLE_ID,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            },

            ...(config.management_role_id ? [{
                id: config.management_role_id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            }] : [])
        ]
    });

    await db(`
        INSERT INTO tickets (
            channel_id,
            guild_id,
            opener_id,
            opener_tag,
            status,
            category,
            tags
        )
        VALUES (
            $1,$2,$3,$4,'open','General',
            ARRAY[]::TEXT[]
        )
    `, [
        channel.id,
        guild.id,
        user.id,
        user.tag
    ]);

    await ensureChecklist(
        channel.id,
        guild.id
    );

    await addTicketHistory(
        channel.id,
        guild.id,
        user.id,
        user.tag,
        "TICKET_CREATED",
        "Ticket created."
    );

    const ticket = await getCurrentTicket(
        channel.id
    );

    const embed = ticketControlPanel(
        ticket,
        config
    );

    await channel.send({
        content:
            `👋 Welcome <@${user.id}>!\n\n` +
            "Please explain what you need help with. " +
            "A staff member will assist you shortly.",

        embeds: [embed],

        components: ticketControlButtons()
    });

    return {
        existing: false,
        channelId: channel.id
    };
}

// ============================================================
// CLAIM PERMISSIONS
// ============================================================

async function applyClaimPermissions(
    channel,
    claimerId
) {

    const ticket = await getCurrentTicket(
        channel.id
    );

    if (!ticket) {
        return;
    }

    const config = await getTicketConfig(
        channel.guild.id
    );

    // Support role cannot speak once claimed.
    if (config?.support_role_id) {

        await channel.permissionOverwrites.edit(
            config.support_role_id,
            {
                SendMessages: false,
                AddReactions: false
            }
        );
    }

    // Management role cannot speak unless they are
    // individually approved or are the manager handling it.
    if (config?.management_role_id) {

        await channel.permissionOverwrites.edit(
            config.management_role_id,
            {
                SendMessages: false,
                AddReactions: false
            }
        );
    }

    // Client can always speak.
    await channel.permissionOverwrites.edit(
        ticket.opener_id,
        {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
        }
    );

    // Claimer can always speak.
    await channel.permissionOverwrites.edit(
        claimerId,
        {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AddReactions: true
        }
    );
}

// ============================================================
// UNCLAIM PERMISSIONS
// ============================================================

async function restoreUnclaimedPermissions(channel) {

    const ticket = await getCurrentTicket(
        channel.id
    );

    if (!ticket) {
        return;
    }

    const config = await getTicketConfig(
        channel.guild.id
    );

    if (config?.support_role_id) {

        await channel.permissionOverwrites.edit(
            config.support_role_id,
            {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true
            }
        );
    }

    if (config?.management_role_id) {

        await channel.permissionOverwrites.edit(
            config.management_role_id,
            {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true
            }
        );
    }

    await channel.permissionOverwrites.edit(
        ticket.opener_id,
        {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
        }
    );
}

// ============================================================
// ADD JOINED STAFF MEMBER
// ============================================================

async function allowJoinedStaff(
    channel,
    userId
) {

    await channel.permissionOverwrites.edit(
        userId,
        {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AddReactions: true
        }
    );

    await db(`
        INSERT INTO ticket_joiners (
            channel_id,
            user_id
        )
        VALUES ($1,$2)
        ON CONFLICT (channel_id,user_id)
        DO NOTHING
    `, [
        channel.id,
        userId
    ]);

    await addTicketHistory(
        channel.id,
        channel.guild.id,
        userId,
        null,
        "STAFF_JOINED",
        "Staff member was approved through Request to Join."
    );
}

// ============================================================
// TRANSFER REQUEST
// ============================================================

async function createTransferRequest(
    channel,
    fromUser,
    targetUser,
    reason = ""
) {

    const existing = await db(`
        SELECT *
        FROM ticket_transfer_requests
        WHERE channel_id = $1
        AND target_user_id = $2
        AND status = 'pending'
        LIMIT 1
    `, [
        channel.id,
        targetUser.id
    ]);

    if (existing.rows.length) {
        return {
            alreadyPending: true
        };
    }

    const result = await db(`
        INSERT INTO ticket_transfer_requests (
            channel_id,
            guild_id,
            from_user_id,
            target_user_id,
            reason
        )
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id
    `, [
        channel.id,
        channel.guild.id,
        fromUser.id,
        targetUser.id,
        reason
    ]);

    const requestId = result.rows[0].id;

    pendingTransferRequests.set(
        String(requestId),
        {
            channelId: channel.id,
            targetUserId: targetUser.id
        }
    );

    await addTicketHistory(
        channel.id,
        channel.guild.id,
        fromUser.id,
        fromUser.tag,
        "TRANSFER_REQUESTED",
        `Transfer requested for ${targetUser.tag}.`
    );

    return {
        alreadyPending: false,
        requestId
    };
}

// ============================================================
// TRANSFER EMBED
// ============================================================

function transferRequestEmbed(
    channel,
    fromUser,
    targetUser,
    reason
) {

    return new EmbedBuilder()
        .setColor(COLORS.orange)
        .setTitle("🔄 Ticket Transfer Request")
        .setDescription(
            `<@${targetUser.id}> has been requested to take over this ticket.\n\n` +

            `**Ticket:** ${channel}\n` +
            `**Requested by:** <@${fromUser.id}>\n` +
            `**Requested staff:** <@${targetUser.id}>\n\n` +

            `**Reason:**\n` +
            `${reason || "No reason provided."}\n\n` +

            `Only **<@${targetUser.id}>** can accept or deny this transfer.`
        )
        .setFooter({
            text: "DeadSignal Ticket Transfer"
        })
        .setTimestamp();
}

// ============================================================
// TRANSFER BUTTONS
// ============================================================

function transferButtons(requestId) {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `transfer_accept_${requestId}`
                )
                .setLabel("Accept")
                .setEmoji("✅")
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId(
                    `transfer_deny_${requestId}`
                )
                .setLabel("Deny")
                .setEmoji("❌")
                .setStyle(ButtonStyle.Danger)
        );
}

// ============================================================
// FEEDBACK SYSTEM
// ============================================================

async function requestTicketFeedback(
    channel,
    ticket
) {

    const user = await client.users.fetch(
        ticket.opener_id
    ).catch(() => null);

    if (!user) {
        return false;
    }

    pendingFeedback.set(
        ticket.channel_id,
        {
            channelId: ticket.channel_id,
            guildId: ticket.guild_id,
            userId: ticket.opener_id,
            staffId: ticket.claimer_id
        }
    );

    try {

        await user.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.green)
                    .setTitle("💬 DeadSignal Support Feedback")
                    .setDescription(
                        `Your ticket in **${channel.guild.name}** has been handled.\n\n` +
                        "Please reply to this DM with your feedback.\n\n" +
                        "You can simply type something like:\n" +
                        `> "Staff were helpful and solved my issue."`
                    )
                    .setTimestamp()
            ]
        });

        return true;

    } catch (error) {

        console.log(
            "[FEEDBACK] Could not DM user:",
            error.message
        );

        return false;
    }
}

// ============================================================
// FINISH CLOSE
// ============================================================

async function finishTicketClose(
    channel,
    reason,
    closedBy
) {

    const ticket = await getCurrentTicket(
        channel.id
    );

    if (!ticket) {
        return;
    }

    await db(`
        UPDATE tickets
        SET
            status = 'closed',
            close_reason = $1,
            closed_by = $2,
            closed_at = NOW()
        WHERE channel_id = $3
    `, [
        reason,
        closedBy.id,
        channel.id
    ]);

    await addTicketHistory(
        channel.id,
        channel.guild.id,
        closedBy.id,
        closedBy.tag,
        "TICKET_CLOSED",
        reason
    );

    const config = await getTicketConfig(
        channel.guild.id
    );

    // Lock the ticket.
    await channel.permissionOverwrites.edit(
        ticket.opener_id,
        {
            SendMessages: false
        }
    );

    if (config?.support_role_id) {

        await channel.permissionOverwrites.edit(
            config.support_role_id,
            {
                SendMessages: false
            }
        );
    }

    if (config?.management_role_id) {

        await channel.permissionOverwrites.edit(
            config.management_role_id,
            {
                SendMessages: false
            }
        );
    }

    await channel.send({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.red)
                .setTitle("🔴 Ticket Closed")
                .setDescription(
                    `**Reason:** ${reason}\n\n` +
                    `Closed by: <@${closedBy.id}>`
                )
                .setTimestamp()
        ]
    });

    setTimeout(async () => {

        await channel.delete().catch(() => {});

    }, 5000);
}

// ============================================================
// IMMEDIATE AFK CLOSE
// ============================================================

async function closeTicketAFK(
    channel,
    closedBy
) {

    await finishTicketClose(
        channel,
        "Client is AFK",
        closedBy
    );
}

// ============================================================
// HANDLED CLOSE
// ============================================================

async function closeTicketHandled(
    channel,
    closedBy
) {

    const ticket = await getCurrentTicket(
        channel.id
    );

    if (!ticket) {
        return;
    }

    await db(`
        UPDATE tickets
        SET close_reason = 'Handled'
        WHERE channel_id = $1
    `, [
        channel.id
    ]);

    const feedbackSent =
        await requestTicketFeedback(
            channel,
            ticket
        );

    if (!feedbackSent) {

        await finishTicketClose(
            channel,
            "Handled",
            closedBy
        );

        return;
    }

    await channel.send({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.green)
                .setTitle("💬 Feedback Requested")
                .setDescription(
                    "The client has been sent a feedback request.\n\n" +
                    "The ticket will remain in the feedback stage until they respond."
                )
                .setTimestamp()
        ]
    });
}

// ============================================================
// CLOSE CHOICE EMBED
// ============================================================

function closeChoiceButtons() {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId("feedback_delete_ticket")
                .setLabel("Delete Ticket")
                .setEmoji("🗑️")
                .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
                .setCustomId("feedback_keep_ticket")
                .setLabel("Keep Ticket Open")
                .setEmoji("📂")
                .setStyle(ButtonStyle.Secondary)
        );
}

// ============================================================
// LOG TICKET
// ============================================================

async function logTicket(
    guild,
    ticket,
    action,
    details
) {

    const config = await getTicketConfig(
        guild.id
    );

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
        .setColor(
            action.includes("CLOSED")
                ? COLORS.red
                : COLORS.blue
        )
        .setTitle(`🎫 Ticket ${action}`)
        .addFields(
            {
                name: "Ticket",
                value: `<#${ticket.channel_id}>`,
                inline: true
            },
            {
                name: "Client",
                value: `<@${ticket.opener_id}>`,
                inline: true
            },
            {
                name: "Details",
                value: details || "None",
                inline: false
            }
        )
        .setTimestamp();

    await channel.send({
        embeds: [embed]
    }).catch(() => {});
}

// ============================================================
// ROBLOX HELPERS
// ============================================================

async function getRobloxUser(username) {

    try {

        const response = await fetch(
            "https://users.roblox.com/v1/usernames/users",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    usernames: [username],
                    excludeBannedUsers: false
                })
            }
        );

        const data = await response.json();

        return data.data?.[0] || null;

    } catch (error) {

        console.log(
            "[ROBLOX] User lookup failed:",
            error.message
        );

        return null;
    }
}

async function getRobloxProfile(userId) {

    try {

        const response = await fetch(
            `https://users.roblox.com/v1/users/${userId}`
        );

        if (!response.ok) {
            return null;
        }

        return await response.json();

    } catch {
        return null;
    }
}

async function getRobloxAvatar(userId) {

    try {

        const response = await fetch(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
        );

        const data = await response.json();

        return data.data?.[0]?.imageUrl || null;

    } catch {
        return null;
    }
}

async function getRobloxFollowers(userId) {

    try {

        const response = await fetch(
            `https://friends.roblox.com/v1/users/${userId}/followers/count`
        );

        const data = await response.json();

        return data.count || 0;

    } catch {
        return 0;
    }
}

// ============================================================
// AUTHORIZATION HELPERS
// ============================================================

async function saveAuthorization(
    username,
    userId,
    authorized,
    source,
    performedBy
) {

    await db(`
        INSERT INTO authorizations (
            roblox_username,
            roblox_user_id,
            authorized,
            authorization_source,
            authorized_by,
            authorized_at
        )
        VALUES (
            $1,$2,$3,$4,$5,
            CASE WHEN $3 = TRUE THEN NOW() ELSE NULL END
        )
        ON CONFLICT (roblox_username)
        DO UPDATE SET
            roblox_user_id = EXCLUDED.roblox_user_id,
            authorized = EXCLUDED.authorized,
            authorization_source = EXCLUDED.authorization_source,
            authorized_by = EXCLUDED.authorized_by,
            authorized_at = EXCLUDED.authorized_at
    `, [
        username,
        userId,
        authorized,
        source,
        performedBy
    ]);

    await db(`
        INSERT INTO authorization_history (
            roblox_username,
            roblox_user_id,
            action,
            source,
            performed_by
        )
        VALUES ($1,$2,$3,$4,$5)
    `, [
        username,
        userId,
        authorized ? "AUTHORIZED" : "REVOKED",
        source,
        performedBy
    ]);
}

// ============================================================
// SERVER STATS
// ============================================================

async function getTicketStats(guildId) {

    const total = await db(`
        SELECT COUNT(*)::INTEGER AS count
        FROM tickets
        WHERE guild_id = $1
    `, [
        guildId
    ]);

    const open = await db(`
        SELECT COUNT(*)::INTEGER AS count
        FROM tickets
        WHERE guild_id = $1
        AND status != 'closed'
    `, [
        guildId
    ]);

    const closed = await db(`
        SELECT COUNT(*)::INTEGER AS count
        FROM tickets
        WHERE guild_id = $1
        AND status = 'closed'
    `, [
        guildId
    ]);

    const claimed = await db(`
        SELECT COUNT(*)::INTEGER AS count
        FROM tickets
        WHERE guild_id = $1
        AND claimer_id IS NOT NULL
        AND status != 'closed'
    `, [
        guildId
    ]);

    return {
        total: total.rows[0]?.count || 0,
        open: open.rows[0]?.count || 0,
        closed: closed.rows[0]?.count || 0,
        claimed: claimed.rows[0]?.count || 0
    };
}

// ============================================================
// LEADERBOARD
// ============================================================

async function updateLeaderboard(guild) {

    const channel =
        guild.channels.cache.get(
            LEADERBOARD_CHANNEL_ID
        );

    if (!channel) {
        return;
    }

    const result = await db(`
        SELECT
            user_id,
            SUM(count)::INTEGER AS total
        FROM ticket_claims
        GROUP BY user_id
        ORDER BY total DESC
        LIMIT 10
    `);

    let description =
        "Top staff members by claimed tickets.\n\n";

    if (!result.rows.length) {
        description += "No ticket claims yet.";
    } else {

        result.rows.forEach((row, index) => {

            description +=
                `**${index + 1}.** <@${row.user_id}> — ` +
                `**${row.total}** claims\n`;
        });
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.purple)
        .setTitle("🏆 DeadSignal Staff Leaderboard")
        .setDescription(description)
        .setFooter({
            text: "Updates automatically"
        })
        .setTimestamp();

    const messages = await channel.messages.fetch({
        limit: 20
    }).catch(() => null);

    if (!messages) {
        return;
    }

    const existing = messages.find(
        message =>
            message.author.id === client.user.id &&
            message.embeds.length &&
            message.embeds[0].title ===
                "🏆 DeadSignal Staff Leaderboard"
    );

    if (existing) {

        await existing.edit({
            embeds: [embed]
        });

    } else {

        await channel.send({
            embeds: [embed]
        });
    }
}

// ============================================================
// CLAIM RECORD
// ============================================================

async function addClaim(
    channelId,
    userId
) {

    await db(`
        INSERT INTO ticket_claims (
            channel_id,
            user_id,
            count
        )
        VALUES ($1,$2,1)
    `, [
        channelId,
        userId
    ]);
}

// ============================================================
// WIPE CLAIMS
// ============================================================

async function wipeClaims(userId) {

    await db(`
        DELETE FROM ticket_claims
        WHERE user_id = $1
    `, [
        userId
    ]);
}

// ============================================================
// INITIALIZE
// ============================================================

setupDatabase()
    .then(() => {
        console.log("[DATABASE] Initialization complete.");
    })
    .catch(error => {
        console.error(
            "[DATABASE] Initialization failed:",
            error
        );
    });

// ============================================================
// DISCORD READY
// ============================================================

client.once("clientReady", async () => {

    console.log(
        `[DISCORD] Logged in as ${client.user.tag}`
    );

    console.log(
        `[DISCORD] User ID: ${client.user.id}`
    );

    console.log(
        "[DISCORD] DeadSignal Auth is ready."
    );

    for (const guild of client.guilds.cache.values()) {

        await updateLeaderboard(guild)
            .catch(error => {
                console.log(
                    "[LEADERBOARD] Update failed:",
                    error.message
                );
            });
    }

    setInterval(async () => {

        for (const guild of client.guilds.cache.values()) {

            await updateLeaderboard(guild)
                .catch(error => {
                    console.log(
                        "[LEADERBOARD] Update failed:",
                        error.message
                    );
                });
        }

    }, 30 * 60 * 1000);
});

// ============================================================
// ERROR HANDLING
// ============================================================

process.on("unhandledRejection", error => {

    console.error(
        "[UNHANDLED REJECTION]",
        error
    );
});

process.on("uncaughtException", error => {

    console.error(
        "[UNCAUGHT EXCEPTION]",
        error
    );
});

// ============================================================
// PART 1 END
// ============================================================

// PART 2 WILL ADD:
//
// /auth
// /check
// /profile
// /history
//
// /ticket setup
// /ticket panel
// /ticket claim
// /ticket unclaim
// /ticket transfer
// /ticket rename
// /ticket add
// /ticket remove
// /ticket close
// /ticket forceclose
//
// Ticket Control Panel interactions
// Close Panel
// Client is AFK close
// Handled close + feedback
// Transfer Accept / Deny
// Request to Join
// Join Accept / Deny
// Status selector
// Checklist buttons
// Tag selector
// Ticket History panel
// Staff Notes modal
// Ticket creation button
// Ticket feedback system
// DM feedback handling
// Ticket transcripts
// Escalation
// /stats
// /wipetickets
//
// ============================================================

// ============================================================
//                  DEADSIGNAL AUTH BOT
//                    TICKET SYSTEM
//                       PART 2/2
// ============================================================

// ============================================================
// COMMAND DEFINITIONS
// ============================================================

const commands = [

    new SlashCommandBuilder()
        .setName("auth")
        .setDescription("Authorize a Roblox user.")
        .addStringOption(option =>
            option
                .setName("robloxuser")
                .setDescription("Roblox username.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("check")
        .setDescription("Check a Roblox user's authorization.")
        .addStringOption(option =>
            option
                .setName("robloxuser")
                .setDescription("Roblox username.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("profile")
        .setDescription("View a Roblox user's profile.")
        .addStringOption(option =>
            option
                .setName("robloxuser")
                .setDescription("Roblox username.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("history")
        .setDescription("View authorization history.")
        .addStringOption(option =>
            option
                .setName("robloxuser")
                .setDescription("Roblox username.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("escalate")
        .setDescription("Escalate the current ticket."),

    new SlashCommandBuilder()
        .setName("stats")
        .setDescription("View ticket statistics."),

    new SlashCommandBuilder()
        .setName("wipetickets")
        .setDescription("Wipe a staff member's ticket claim statistics.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Staff member.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Manage DeadSignal tickets.")

        .addSubcommand(sub =>
            sub
                .setName("setup")
                .setDescription("Configure the ticket system.")
                .addRoleOption(option =>
                    option
                        .setName("support_role")
                        .setDescription("Support role.")
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option
                        .setName("management_role")
                        .setDescription("Management role.")
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName("category")
                        .setDescription("Ticket category.")
                        .addChannelTypes(
                            ChannelType.GuildCategory
                        )
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName("log_channel")
                        .setDescription("Ticket log channel.")
                        .addChannelTypes(
                            ChannelType.GuildText
                        )
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName("panel_channel")
                        .setDescription("Ticket panel channel.")
                        .addChannelTypes(
                            ChannelType.GuildText
                        )
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("panel")
                .setDescription("Send the ticket panel.")
        )

        .addSubcommand(sub =>
            sub
                .setName("claim")
                .setDescription("Claim the current ticket.")
        )

        .addSubcommand(sub =>
            sub
                .setName("unclaim")
                .setDescription("Unclaim the current ticket.")
        )

        .addSubcommand(sub =>
            sub
                .setName("transfer")
                .setDescription("Request to transfer the ticket.")
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription("Staff member to request.")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("reason")
                        .setDescription("Reason for the transfer.")
                        .setRequired(false)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("rename")
                .setDescription("Rename the current ticket.")
                .addStringOption(option =>
                    option
                        .setName("name")
                        .setDescription("New ticket name.")
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("add")
                .setDescription("Add a user to the ticket.")
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription("User to add.")
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("remove")
                .setDescription("Remove a user from the ticket.")
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription("User to remove.")
                        .setRequired(true)
                )
        )

        .addSubcommand(sub =>
            sub
                .setName("close")
                .setDescription("Open the ticket close panel.")
        )

        .addSubcommand(sub =>
            sub
                .setName("forceclose")
                .setDescription("Immediately close the current ticket.")
        )
];

// ============================================================
// REGISTER COMMANDS
// ============================================================

client.once("clientReady", async () => {

    try {

        await client.application.commands.set(
            commands.map(command => command.toJSON())
        );

        console.log(
            `[COMMANDS] Registered ${commands.length} commands.`
        );

    } catch (error) {

        console.error(
            "[COMMANDS] Registration failed:",
            error
        );
    }
});

// ============================================================
// TICKET CREATE PANEL
// ============================================================

function ticketPanelEmbed(config) {

    return new EmbedBuilder()
        .setColor(getColor(config, "panel"))
        .setTitle("🎫 DeadSignal Support")
        .setDescription(
            "Need help? Create a support ticket below.\n\n" +

            "**Before opening a ticket:**\n" +
            "• Explain your issue clearly.\n" +
            "• Include relevant information.\n" +
            "• Do not spam multiple tickets.\n\n" +

            "A member of staff will assist you as soon as possible."
        )
        .addFields({
            name: "📌 Support",
            value:
                "Authorization\n" +
                "Payments\n" +
                "Scripts\n" +
                "Technical Support\n" +
                "General Support",
            inline: true
        })
        .setFooter({
            text: "DeadSignal Support"
        });
}

function ticketPanelButton() {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId("ticket_create")
                .setLabel("Create Ticket")
                .setEmoji("🎫")
                .setStyle(ButtonStyle.Primary)
        );
}

// ============================================================
// GET CURRENT TICKET
// ============================================================

async function requireTicket(interaction) {

    if (!interaction.channel) {
        return null;
    }

    return await getCurrentTicket(
        interaction.channel.id
    );
}

// ============================================================
// INTERACTION HANDLER
// ============================================================

client.on("interactionCreate", async interaction => {

    try {

        // ====================================================
        // BUTTONS / SELECT MENUS / MODALS
        // ====================================================

        if (
            interaction.isButton() ||
            interaction.isStringSelectMenu() ||
            interaction.isModalSubmit()
        ) {

            // ------------------------------------------------
            // DM FEEDBACK BUTTONS
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.channel &&
                !interaction.guild
            ) {

                if (
                    interaction.customId ===
                    "feedback_delete_ticket"
                ) {

                    const data =
                        pendingCloseChoice.get(
                            interaction.user.id
                        );

                    if (!data) {

                        return interaction.reply({
                            content:
                                "This feedback request has expired.",
                            ephemeral: true
                        });
                    }

                    pendingCloseChoice.delete(
                        interaction.user.id
                    );

                    const guild =
                        client.guilds.cache.get(
                            data.guildId
                        );

                    const channel =
                        guild?.channels.cache.get(
                            data.channelId
                        );

                    if (!channel) {

                        return interaction.reply({
                            content:
                                "The ticket no longer exists.",
                            ephemeral: true
                        });
                    }

                    await finishTicketClose(
                        channel,
                        "Handled",
                        await client.users.fetch(
                            data.staffId
                        ).catch(() => interaction.user)
                    );

                    return interaction.update({
                        content:
                            "✅ The ticket has been closed.",
                        embeds: [],
                        components: []
                    });
                }

                if (
                    interaction.customId ===
                    "feedback_keep_ticket"
                ) {

                    const data =
                        pendingCloseChoice.get(
                            interaction.user.id
                        );

                    if (!data) {

                        return interaction.reply({
                            content:
                                "This feedback request has expired.",
                            ephemeral: true
                        });
                    }

                    pendingCloseChoice.delete(
                        interaction.user.id
                    );

                    const channel =
                        client.channels.cache.get(
                            data.channelId
                        );

                    if (channel) {

                        await db(`
                            UPDATE tickets
                            SET status = 'resolved'
                            WHERE channel_id = $1
                        `, [
                            data.channelId
                        ]);

                        await addTicketHistory(
                            data.channelId,
                            data.guildId,
                            interaction.user.id,
                            interaction.user.tag,
                            "FEEDBACK_KEEP_OPEN",
                            "Client chose to keep the ticket open."
                        );
                    }

                    return interaction.update({
                        content:
                            "📂 The ticket will remain open.",
                        embeds: [],
                        components: []
                    });
                }
            }

            // ------------------------------------------------
            // ALL GUILD TICKET INTERACTIONS
            // ------------------------------------------------

            if (!interaction.guild) {
                return;
            }

            const member =
                await interaction.guild.members.fetch(
                    interaction.user.id
                ).catch(() => null);

            // ------------------------------------------------
            // CREATE TICKET
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "ticket_create"
            ) {

                await interaction.deferReply({
                    ephemeral: true
                });

                const result =
                    await createTicket(
                        interaction.guild,
                        interaction.user
                    );

                if (result.existing) {

                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                "Existing Ticket",
                                `You already have an open ticket: <#${result.channelId}>`
                            )
                        ]
                    });
                }

                return interaction.editReply({
                    embeds: [
                        successEmbed(
                            "Ticket Created",
                            `Your ticket has been created: <#${result.channelId}>`
                        )
                    ]
                });
            }

            // ------------------------------------------------
            // REQUEST TO JOIN
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "ticket_join"
            ) {

                if (!(await isSupport(member)) &&
                    !(await isManagement(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to request to join tickets.",
                        ephemeral: true
                    });
                }

                const ticket =
                    await getCurrentTicket(
                        interaction.channel.id
                    );

                if (!ticket) {
                    return;
                }

                if (
                    ticket.claimer_id ===
                    interaction.user.id
                ) {

                    return interaction.reply({
                        content:
                            "❌ You are already the assigned staff member.",
                        ephemeral: true
                    });
                }

                if (
                    ticket.opener_id ===
                    interaction.user.id
                ) {

                    return interaction.reply({
                        content:
                            "❌ The client cannot request to join.",
                        ephemeral: true
                    });
                }

                const joined =
                    await getJoinedStaffCount(
                        interaction.channel.id
                    );

                if (joined >= 1) {

                    return interaction.reply({
                        content:
                            "❌ The maximum of 1 additional staff member has already been reached.",
                        ephemeral: true
                    });
                }

                const existing =
                    await db(`
                        SELECT *
                        FROM ticket_join_requests
                        WHERE channel_id = $1
                        AND user_id = $2
                        AND status = 'pending'
                        LIMIT 1
                    `, [
                        interaction.channel.id,
                        interaction.user.id
                    ]);

                if (existing.rows.length) {

                    return interaction.reply({
                        content:
                            "❌ You already have a pending request.",
                        ephemeral: true
                    });
                }

                const modal =
                    new ModalBuilder()
                        .setCustomId(
                            `join_reason_${interaction.channel.id}`
                        )
                        .setTitle(
                            "Request to Join Ticket"
                        );

                const reason =
                    new TextInputBuilder()
                        .setCustomId(
                            "join_reason"
                        )
                        .setLabel(
                            "Why should you be accepted?"
                        )
                        .setPlaceholder(
                            "Explain why you need to join this ticket..."
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setMinLength(5)
                        .setMaxLength(500)
                        .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder()
                        .addComponents(reason)
                );

                return interaction.showModal(modal);
            }

            // ------------------------------------------------
            // JOIN REQUEST ACCEPT / DENY
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                (
                    interaction.customId.startsWith(
                        "join_accept_"
                    ) ||
                    interaction.customId.startsWith(
                        "join_deny_"
                    )
                )
            ) {

                if (!(await isManagement(member)) &&
                    !(await isSupport(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to decide join requests.",
                        ephemeral: true
                    });
                }

                const parts =
                    interaction.customId.split("_");

                const action = parts[1];
                const requestId = parts[2];

                const result =
                    await db(`
                        SELECT *
                        FROM ticket_join_requests
                        WHERE id = $1
                        LIMIT 1
                    `, [
                        requestId
                    ]);

                if (!result.rows.length) {

                    return interaction.reply({
                        content:
                            "❌ This join request no longer exists.",
                        ephemeral: true
                    });
                }

                const request =
                    result.rows[0];

                if (
                    request.status !==
                    "pending"
                ) {

                    return interaction.reply({
                        content:
                            "❌ This request has already been handled.",
                        ephemeral: true
                    });
                }

                if (
                    action === "deny"
                ) {

                    await db(`
                        UPDATE ticket_join_requests
                        SET
                            status = 'denied',
                            decided_by = $1,
                            decided_at = NOW()
                        WHERE id = $2
                    `, [
                        interaction.user.id,
                        requestId
                    ]);

                    await addTicketHistory(
                        request.channel_id,
                        request.guild_id,
                        interaction.user.id,
                        interaction.user.tag,
                        "JOIN_DENIED",
                        `<@${request.user_id}> was denied access to the ticket.`
                    );

                    return interaction.update({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(COLORS.red)
                                .setTitle(
                                    "❌ Join Request Denied"
                                )
                                .setDescription(
                                    `<@${request.user_id}>'s request was denied by <@${interaction.user.id}>.`
                                )
                                .setTimestamp()
                        ],
                        components: []
                    });
                }

                // --------------------------------------------
                // ACCEPT
                // --------------------------------------------

                const joined =
                    await getJoinedStaffCount(
                        request.channel_id
                    );

                if (joined >= 1) {

                    return interaction.reply({
                        content:
                            "❌ Another staff member has already joined this ticket.",
                        ephemeral: true
                    });
                }

                const channel =
                    interaction.guild.channels.cache.get(
                        request.channel_id
                    );

                if (!channel) {

                    return interaction.reply({
                        content:
                            "❌ Ticket channel no longer exists.",
                        ephemeral: true
                    });
                }

                await db(`
                    UPDATE ticket_join_requests
                    SET
                        status = 'accepted',
                        decided_by = $1,
                        decided_at = NOW()
                    WHERE id = $2
                `, [
                    interaction.user.id,
                    requestId
                ]);

                await allowJoinedStaff(
                    channel,
                    request.user_id
                );

                const count =
                    await getJoinedStaffCount(
                        channel.id
                    );

                await addTicketHistory(
                    channel.id,
                    channel.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "JOIN_ACCEPTED",
                    `<@${request.user_id}> was accepted. (${count}/1)`
                );

                await interaction.update({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.green)
                            .setTitle(
                                "✅ Staff Member Accepted"
                            )
                            .setDescription(
                                `<@${request.user_id}> has joined the ticket.\n\n` +
                                `**Joined:** ${count}/1`
                            )
                            .setTimestamp()
                    ],
                    components: []
                });

                await channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.green)
                            .setTitle(
                                "👥 Staff Member Joined"
                            )
                            .setDescription(
                                `<@${request.user_id}> has been approved to join this ticket.\n\n` +
                                `**Additional staff:** ${count}/1`
                            )
                            .setTimestamp()
                    ]
                });

                await refreshTicketPanel(
                    channel
                );

                return;
            }

            // ------------------------------------------------
            // JOIN REQUEST MODAL
            // ------------------------------------------------

            if (
                interaction.isModalSubmit() &&
                interaction.customId.startsWith(
                    "join_reason_"
                )
            ) {

                const channelId =
                    interaction.customId.replace(
                        "join_reason_",
                        ""
                    );

                const ticket =
                    await getCurrentTicket(
                        channelId
                    );

                if (!ticket) {

                    return interaction.reply({
                        content:
                            "❌ This ticket no longer exists.",
                        ephemeral: true
                    });
                }

                const joined =
                    await getJoinedStaffCount(
                        channelId
                    );

                if (joined >= 1) {

                    return interaction.reply({
                        content:
                            "❌ The additional staff slot has already been filled.",
                        ephemeral: true
                    });
                }

                const reason =
                    interaction.fields.getTextInputValue(
                        "join_reason"
                    );

                const result =
                    await db(`
                        INSERT INTO ticket_join_requests (
                            channel_id,
                            guild_id,
                            user_id,
                            user_tag,
                            reason
                        )
                        VALUES ($1,$2,$3,$4,$5)
                        RETURNING id
                    `, [
                        channelId,
                        interaction.guild.id,
                        interaction.user.id,
                        interaction.user.tag,
                        reason
                    ]);

                const requestId =
                    result.rows[0].id;

                await addTicketHistory(
                    channelId,
                    interaction.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "JOIN_REQUESTED",
                    reason
                );

                const channel =
                    interaction.guild.channels.cache.get(
                        channelId
                    );

                if (channel) {

                    await channel.send({
                        content:
                            `👤 <@${interaction.user.id}> would like to join the ticket.`,

                        embeds: [
                            new EmbedBuilder()
                                .setColor(COLORS.orange)
                                .setTitle(
                                    "Staff Join Request"
                                )
                                .addFields(
                                    {
                                        name: "👤 Requesting Staff",
                                        value:
                                            `<@${interaction.user.id}>`,
                                        inline: true
                                    },
                                    {
                                        name: "👥 Joined",
                                        value:
                                            `${joined}/1`,
                                        inline: true
                                    },
                                    {
                                        name: "📝 Reason",
                                        value: reason,
                                        inline: false
                                    }
                                )
                                .setDescription(
                                    "Only an authorised staff member can accept or deny this request."
                                )
                                .setTimestamp()
                        ],

                        components: [
                            new ActionRowBuilder()
                                .addComponents(

                                    new ButtonBuilder()
                                        .setCustomId(
                                            `join_accept_${requestId}`
                                        )
                                        .setLabel("Accept")
                                        .setEmoji("✅")
                                        .setStyle(
                                            ButtonStyle.Success
                                        ),

                                    new ButtonBuilder()
                                        .setCustomId(
                                            `join_deny_${requestId}`
                                        )
                                        .setLabel("Deny")
                                        .setEmoji("❌")
                                        .setStyle(
                                            ButtonStyle.Danger
                                        )
                                )
                        ]
                    });
                }

                return interaction.reply({
                    content:
                        "✅ Your request has been sent to the ticket.",
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // TRANSFER BUTTON
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "ticket_transfer"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to transfer tickets.",
                        ephemeral: true
                    });
                }

                const modal =
                    new ModalBuilder()
                        .setCustomId(
                            `transfer_modal_${interaction.channel.id}`
                        )
                        .setTitle(
                            "Transfer Ticket"
                        );

                const userInput =
                    new TextInputBuilder()
                        .setCustomId(
                            "target_user"
                        )
                        .setLabel(
                            "Staff Discord ID"
                        )
                        .setPlaceholder(
                            "Enter the staff member's Discord ID"
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(true);

                const reasonInput =
                    new TextInputBuilder()
                        .setCustomId(
                            "transfer_reason"
                        )
                        .setLabel(
                            "Reason"
                        )
                        .setPlaceholder(
                            "Why are you transferring this ticket?"
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setRequired(false);

                modal.addComponents(
                    new ActionRowBuilder()
                        .addComponents(userInput),

                    new ActionRowBuilder()
                        .addComponents(reasonInput)
                );

                return interaction.showModal(
                    modal
                );
            }

            // ------------------------------------------------
            // TRANSFER MODAL
            // ------------------------------------------------

            if (
                interaction.isModalSubmit() &&
                interaction.customId.startsWith(
                    "transfer_modal_"
                )
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to transfer tickets.",
                        ephemeral: true
                    });
                }

                const channelId =
                    interaction.customId.replace(
                        "transfer_modal_",
                        ""
                    );

                const channel =
                    interaction.guild.channels.cache.get(
                        channelId
                    );

                const ticket =
                    await getCurrentTicket(
                        channelId
                    );

                if (!channel || !ticket) {

                    return interaction.reply({
                        content:
                            "❌ Ticket not found.",
                        ephemeral: true
                    });
                }

                const targetId =
                    interaction.fields.getTextInputValue(
                        "target_user"
                    ).trim();

                const reason =
                    interaction.fields.getTextInputValue(
                        "transfer_reason"
                    ).trim();

                const target =
                    await interaction.guild.members.fetch(
                        targetId
                    ).catch(() => null);

                if (!target) {

                    return interaction.reply({
                        content:
                            "❌ I could not find that staff member in this server.",
                        ephemeral: true
                    });
                }

                if (!(await isSupport(target)) &&
                    !(await isManagement(target))) {

                    return interaction.reply({
                        content:
                            "❌ That user is not a Support or Management member.",
                        ephemeral: true
                    });
                }

                if (
                    target.id ===
                    interaction.user.id
                ) {

                    return interaction.reply({
                        content:
                            "❌ You cannot transfer a ticket to yourself.",
                        ephemeral: true
                    });
                }

                const request =
                    await createTransferRequest(
                        channel,
                        interaction.user,
                        target.user,
                        reason
                    );

                if (request.alreadyPending) {

                    return interaction.reply({
                        content:
                            "❌ That staff member already has a pending transfer request for this ticket.",
                        ephemeral: true
                    });
                }

                await channel.send({
                    content:
                        `<@${target.id}>`,

                    embeds: [
                        transferRequestEmbed(
                            channel,
                            interaction.user,
                            target.user,
                            reason
                        )
                    ],

                    components: [
                        transferButtons(
                            request.requestId
                        )
                    ]
                });

                return interaction.reply({
                    content:
                        "✅ Transfer request sent. Only the selected staff member can accept or deny it.",
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // TRANSFER ACCEPT / DENY
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                (
                    interaction.customId.startsWith(
                        "transfer_accept_"
                    ) ||
                    interaction.customId.startsWith(
                        "transfer_deny_"
                    )
                )
            ) {

                const accepted =
                    interaction.customId.startsWith(
                        "transfer_accept_"
                    );

                const requestId =
                    interaction.customId.split("_").pop();

                const result =
                    await db(`
                        SELECT *
                        FROM ticket_transfer_requests
                        WHERE id = $1
                        LIMIT 1
                    `, [
                        requestId
                    ]);

                if (!result.rows.length) {

                    return interaction.reply({
                        content:
                            "❌ Transfer request not found.",
                        ephemeral: true
                    });
                }

                const request =
                    result.rows[0];

                // IMPORTANT:
                // Only the requested staff member
                // can interact with these buttons.
                if (
                    request.target_user_id !==
                    interaction.user.id
                ) {

                    return interaction.reply({
                        content:
                            "❌ This transfer request is not for you.",
                        ephemeral: true
                    });
                }

                if (
                    request.status !==
                    "pending"
                ) {

                    return interaction.reply({
                        content:
                            "❌ This transfer request has already been handled.",
                        ephemeral: true
                    });
                }

                if (!accepted) {

                    await db(`
                        UPDATE ticket_transfer_requests
                        SET
                            status = 'denied',
                            decided_by = $1,
                            decided_at = NOW()
                        WHERE id = $2
                    `, [
                        interaction.user.id,
                        requestId
                    ]);

                    await addTicketHistory(
                        request.channel_id,
                        request.guild_id,
                        interaction.user.id,
                        interaction.user.tag,
                        "TRANSFER_DENIED",
                        `Transfer request ${requestId} denied.`
                    );

                    return interaction.update({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(COLORS.red)
                                .setTitle(
                                    "❌ Transfer Denied"
                                )
                                .setDescription(
                                    `<@${interaction.user.id}> denied the ticket transfer request.`
                                )
                                .setTimestamp()
                        ],
                        components: []
                    });
                }

                const channel =
                    interaction.guild.channels.cache.get(
                        request.channel_id
                    );

                if (!channel) {

                    return interaction.reply({
                        content:
                            "❌ Ticket channel no longer exists.",
                        ephemeral: true
                    });
                }

                const ticket =
                    await getCurrentTicket(
                        channel.id
                    );

                if (!ticket) {

                    return interaction.reply({
                        content:
                            "❌ Ticket no longer exists.",
                        ephemeral: true
                    });
                }

                // Remove old claimer's explicit access.
                if (ticket.claimer_id) {

                    await channel.permissionOverwrites.edit(
                        ticket.claimer_id,
                        {
                            SendMessages: false
                        }
                    );
                }

                await db(`
                    UPDATE tickets
                    SET
                        claimer_id = $1,
                        status = 'claimed',
                        claimed_at = NOW(),
                        transferred_from = $2,
                        transferred_at = NOW()
                    WHERE channel_id = $3
                `, [
                    interaction.user.id,
                    ticket.claimer_id,
                    channel.id
                ]);

                // Remove previously joined staff.
                const joined =
                    await db(`
                        SELECT user_id
                        FROM ticket_joiners
                        WHERE channel_id = $1
                    `, [
                        channel.id
                    ]);

                for (const row of joined.rows) {

                    await channel.permissionOverwrites.edit(
                        row.user_id,
                        {
                            SendMessages: false
                        }
                    );
                }

                await db(`
                    DELETE FROM ticket_joiners
                    WHERE channel_id = $1
                `, [
                    channel.id
                ]);

                await applyClaimPermissions(
                    channel,
                    interaction.user.id
                );

                await addClaim(
                    channel.id,
                    interaction.user.id
                );

                await db(`
                    UPDATE ticket_transfer_requests
                    SET
                        status = 'accepted',
                        decided_by = $1,
                        decided_at = NOW()
                    WHERE id = $2
                `, [
                    interaction.user.id,
                    requestId
                ]);

                await addTicketHistory(
                    channel.id,
                    channel.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "TRANSFER_ACCEPTED",
                    `Ticket transferred from <@${ticket.claimer_id || "unknown"}>.`
                );

                await interaction.update({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.green)
                            .setTitle(
                                "✅ Ticket Transferred"
                            )
                            .setDescription(
                                `<@${interaction.user.id}> is now responsible for this ticket.`
                            )
                            .setTimestamp()
                    ],
                    components: []
                });

                await channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.green)
                            .setTitle(
                                "🔄 Ticket Transferred"
                            )
                            .setDescription(
                                `This ticket has been transferred to <@${interaction.user.id}>.`
                            )
                            .setTimestamp()
                    ]
                });

                await refreshTicketPanel(
                    channel
                );

                return;
            }

            // ------------------------------------------------
            // CLOSE PANEL
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "ticket_close_panel"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to close tickets.",
                        ephemeral: true
                    });
                }

                return interaction.reply({
                    embeds: [
                        closePanelEmbed()
                    ],
                    components: [
                        closePanelButtons()
                    ],
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // CLOSE - AFK
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "close_reason_afk"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You cannot close this ticket.",
                        ephemeral: true
                    });
                }

                await interaction.update({
                    content:
                        "💤 Closing ticket because the client is AFK...",
                    embeds: [],
                    components: []
                });

                await closeTicketAFK(
                    interaction.channel,
                    interaction.user
                );

                return;
            }

            // ------------------------------------------------
            // CLOSE - HANDLED
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "close_reason_handled"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You cannot close this ticket.",
                        ephemeral: true
                    });
                }

                await interaction.update({
                    content:
                        "💬 Sending feedback request to the client...",
                    embeds: [],
                    components: []
                });

                await closeTicketHandled(
                    interaction.channel,
                    interaction.user
                );

                return;
            }

            // ------------------------------------------------
            // CLOSE CANCEL
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "close_cancel"
            ) {

                return interaction.update({
                    content:
                        "❌ Ticket closure cancelled.",
                    embeds: [],
                    components: []
                });
            }

            // ------------------------------------------------
            // STATUS BUTTON
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "ticket_status"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to change ticket status.",
                        ephemeral: true
                    });
                }

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.blue)
                            .setTitle("📌 Ticket Status")
                            .setDescription(
                                "Select the current status of this ticket."
                            )
                    ],
                    components: [
                        statusPanel()
                    ],
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // STATUS SELECT
            // ------------------------------------------------

            if (
                interaction.isStringSelectMenu() &&
                interaction.customId ===
                    "ticket_status_select"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to change status.",
                        ephemeral: true
                    });
                }

                const status =
                    interaction.values[0];

                await db(`
                    UPDATE tickets
                    SET status = $1
                    WHERE channel_id = $2
                `, [
                    status,
                    interaction.channel.id
                ]);

                await addTicketHistory(
                    interaction.channel.id,
                    interaction.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "STATUS_CHANGED",
                    status
                );

                await interaction.update({
                    content:
                        `✅ Ticket status changed to **${getStatusInfo(status).label}**.`,
                    embeds: [],
                    components: []
                });

                await refreshTicketPanel(
                    interaction.channel
                );

                return;
            }

            // ------------------------------------------------
            // TAGS BUTTON
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "ticket_tags"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to edit tags.",
                        ephemeral: true
                    });
                }

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.blue)
                            .setTitle("🗂️ Ticket Tags")
                            .setDescription(
                                "Select up to 3 tags for this ticket."
                            )
                    ],
                    components: [
                        tagPanel()
                    ],
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // TAG SELECT
            // ------------------------------------------------

            if (
                interaction.isStringSelectMenu() &&
                interaction.customId ===
                    "ticket_tag_select"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to edit tags.",
                        ephemeral: true
                    });
                }

                const tags =
                    interaction.values.map(
                        value =>
                            value
                                .replace(/_/g, " ")
                                .toUpperCase()
                    );

                await db(`
                    UPDATE tickets
                    SET tags = $1
                    WHERE channel_id = $2
                `, [
                    tags,
                    interaction.channel.id
                ]);

                await addTicketHistory(
                    interaction.channel.id,
                    interaction.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "TAGS_CHANGED",
                    tags.join(", ")
                );

                await interaction.update({
                    content:
                        `✅ Ticket tags updated: ${formatTags(tags)}`,
                    embeds: [],
                    components: []
                });

                await refreshTicketPanel(
                    interaction.channel
                );

                return;
            }

            // ------------------------------------------------
            // CHECKLIST
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "ticket_checklist"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to use the checklist.",
                        ephemeral: true
                    });
                }

                const result =
                    await db(`
                        SELECT *
                        FROM ticket_checklists
                        WHERE channel_id = $1
                    `, [
                        interaction.channel.id
                    ]);

                const checklist =
                    result.rows[0];

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.blue)
                            .setTitle("☑️ Ticket Checklist")
                            .setDescription(
                                checklistText(checklist)
                            )
                    ],
                    components: [
                        checklistPanel(checklist),
                        checklistPanelTwo(checklist)
                    ],
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // CHECKLIST BUTTONS
            // ------------------------------------------------

            const checklistMap = {

                check_customer:
                    "customer_identified",

                check_issue:
                    "issue_identified",

                check_auth:
                    "authorization_checked",

                check_payment:
                    "payment_checked",

                check_solution:
                    "solution_provided",

                check_confirmed:
                    "customer_confirmed",

                check_ready:
                    "ready_to_close"
            };

            if (
                interaction.isButton() &&
                checklistMap[
                    interaction.customId
                ]
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to edit the checklist.",
                        ephemeral: true
                    });
                }

                const column =
                    checklistMap[
                        interaction.customId
                    ];

                await db(`
                    UPDATE ticket_checklists
                    SET ${column} =
                        NOT COALESCE(${column}, FALSE)
                    WHERE channel_id = $1
                `, [
                    interaction.channel.id
                ]);

                const result =
                    await db(`
                        SELECT *
                        FROM ticket_checklists
                        WHERE channel_id = $1
                    `, [
                        interaction.channel.id
                    ]);

                const checklist =
                    result.rows[0];

                return interaction.update({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.blue)
                            .setTitle("☑️ Ticket Checklist")
                            .setDescription(
                                checklistText(checklist)
                            )
                    ],
                    components: [
                        checklistPanel(checklist),
                        checklistPanelTwo(checklist)
                    ]
                });
            }

            // ------------------------------------------------
            // HISTORY
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "ticket_history"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to view ticket history.",
                        ephemeral: true
                    });
                }

                const history =
                    await getTicketHistory(
                        interaction.channel.id,
                        15
                    );

                let description =
                    "No ticket history available.";

                if (history.length) {

                    description =
                        history.map(row => {

                            const time =
                                `<t:${Math.floor(
                                    new Date(row.created_at).getTime() / 1000
                                )}:R>`;

                            return (
                                `**${row.action}** — ${time}\n` +
                                `${row.details || "No details"}\n`
                            );

                        }).join("\n");
                }

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.purple)
                            .setTitle("📜 Ticket History")
                            .setDescription(
                                description.slice(0, 4000)
                            )
                    ],
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // NOTES
            // ------------------------------------------------

            if (
                interaction.isButton() &&
                interaction.customId ===
                    "ticket_notes"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to use staff notes.",
                        ephemeral: true
                    });
                }

                const modal =
                    new ModalBuilder()
                        .setCustomId(
                            `ticket_note_${interaction.channel.id}`
                        )
                        .setTitle(
                            "Add Staff Note"
                        );

                const note =
                    new TextInputBuilder()
                        .setCustomId(
                            "note"
                        )
                        .setLabel(
                            "Internal Staff Note"
                        )
                        .setPlaceholder(
                            "This note will only be visible to staff."
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setMinLength(1)
                        .setMaxLength(1000)
                        .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder()
                        .addComponents(note)
                );

                return interaction.showModal(
                    modal
                );
            }

            // ------------------------------------------------
            // NOTE MODAL
            // ------------------------------------------------

            if (
                interaction.isModalSubmit() &&
                interaction.customId.startsWith(
                    "ticket_note_"
                )
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to add notes.",
                        ephemeral: true
                    });
                }

                const channelId =
                    interaction.customId.replace(
                        "ticket_note_",
                        ""
                    );

                const note =
                    interaction.fields.getTextInputValue(
                        "note"
                    );

                await addTicketNote(
                    channelId,
                    interaction.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    note
                );

                return interaction.reply({
                    content:
                        "📝 Staff note added. It is only visible to staff through the Notes panel.",
                    ephemeral: true
                });
            }
        }

        // ====================================================
        // SLASH COMMANDS
        // ====================================================

        if (!interaction.isChatInputCommand()) {
            return;
        }

        const member =
            await interaction.guild.members.fetch(
                interaction.user.id
            ).catch(() => null);

        // ====================================================
        // AUTH
        // ====================================================

        if (
            interaction.commandName ===
            "auth"
        ) {

            if (!member) {
                return;
            }

            if (!(await isSupport(member)) &&
                !(await isManagement(member)) &&
                !isFinancialOperations(member)) {

                return interaction.reply({
                    content:
                        "❌ You do not have permission to authorize users.",
                    ephemeral: true
                });
            }

            const username =
                interaction.options.getString(
                    "robloxuser"
                );

            await interaction.deferReply({
                ephemeral: true
            });

            const roblox =
                await getRobloxUser(username);

            if (!roblox) {

                return interaction.editReply({
                    embeds: [
                        errorEmbed(
                            "User Not Found",
                            `I could not find the Roblox user **${username}**.`
                        )
                    ]
                });
            }

            await saveAuthorization(
                roblox.name,
                String(roblox.id),
                true,
                "Discord",
                interaction.user.id
            );

            return interaction.editReply({
                embeds: [
                    successEmbed(
                        "User Authorized",
                        `**${roblox.name}** has been authorized.\n\nRoblox ID: \`${roblox.id}\``
                    )
                ]
            });
        }

        // ====================================================
        // CHECK
        // ====================================================

        if (
            interaction.commandName ===
            "check"
        ) {

            const username =
                interaction.options.getString(
                    "robloxuser"
                );

            await interaction.deferReply({
                ephemeral: true
            });

            const result =
                await db(`
                    SELECT *
                    FROM authorizations
                    WHERE LOWER(roblox_username)
                    = LOWER($1)
                    LIMIT 1
                `, [
                    username
                ]);

            if (!result.rows.length) {

                return interaction.editReply({
                    embeds: [
                        errorEmbed(
                            "Not Authorized",
                            `**${username}** is not authorized.`
                        )
                    ]
                });
            }

            const row =
                result.rows[0];

            if (row.rban) {

                return interaction.editReply({
                    embeds: [
                        errorEmbed(
                            "Blocked",
                            `**${row.roblox_username}** is currently blocked.`
                        )
                    ]
                });
            }

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(
                            row.authorized
                                ? COLORS.green
                                : COLORS.red
                        )
                        .setTitle(
                            row.authorized
                                ? "✅ Authorized"
                                : "❌ Not Authorized"
                        )
                        .setDescription(
                            `**User:** ${row.roblox_username}\n` +
                            `**Premium:** ${row.premium ? "Yes" : "No"}\n` +
                            `**Source:** ${row.authorization_source || "Unknown"}`
                        )
                ]
            });
        }

        // ====================================================
        // PROFILE
        // ====================================================

        if (
            interaction.commandName ===
            "profile"
        ) {

            const username =
                interaction.options.getString(
                    "robloxuser"
                );

            await interaction.deferReply();

            const roblox =
                await getRobloxUser(username);

            if (!roblox) {

                return interaction.editReply({
                    embeds: [
                        errorEmbed(
                            "User Not Found",
                            `I could not find **${username}**.`
                        )
                    ]
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

            const followers =
                await getRobloxFollowers(
                    roblox.id
                );

            const result =
                await db(`
                    SELECT *
                    FROM authorizations
                    WHERE LOWER(roblox_username)
                    = LOWER($1)
                    LIMIT 1
                `, [
                    roblox.name
                ]);

            const auth =
                result.rows[0];

            const embed =
                new EmbedBuilder()
                    .setColor(COLORS.blue)
                    .setTitle(
                        `👤 ${roblox.name}`
                    )
                    .setThumbnail(
                        avatar || null
                    )
                    .addFields(
                        {
                            name: "Roblox ID",
                            value:
                                String(roblox.id),
                            inline: true
                        },
                        {
                            name: "Display Name",
                            value:
                                profile?.displayName ||
                                roblox.name,
                            inline: true
                        },
                        {
                            name: "Followers",
                            value:
                                String(followers),
                            inline: true
                        },
                        {
                            name: "Authorization",
                            value:
                                auth?.authorized
                                    ? "✅ Authorized"
                                    : "❌ Not Authorized",
                            inline: true
                        },
                        {
                            name: "Premium",
                            value:
                                auth?.premium
                                    ? "✅ Yes"
                                    : "❌ No",
                            inline: true
                        },
                        {
                            name: "rBan",
                            value:
                                auth?.rban
                                    ? "🔴 Yes"
                                    : "🟢 No",
                            inline: true
                        }
                    )
                    .setTimestamp();

            if (profile?.description) {

                embed.setDescription(
                    profile.description.slice(
                        0,
                        1000
                    )
                );
            }

            return interaction.editReply({
                embeds: [embed]
            });
        }

        // ====================================================
        // AUTH HISTORY
        // ====================================================

        if (
            interaction.commandName ===
            "history"
        ) {

            if (!(await canManageTickets(member)) &&
                !isFinancialOperations(member)) {

                return interaction.reply({
                    content:
                        "❌ You do not have permission to view authorization history.",
                    ephemeral: true
                });
            }

            const username =
                interaction.options.getString(
                    "robloxuser"
                );

            const result =
                await db(`
                    SELECT *
                    FROM authorization_history
                    WHERE LOWER(roblox_username)
                    = LOWER($1)
                    ORDER BY created_at DESC
                    LIMIT 15
                `, [
                    username
                ]);

            let description =
                "No history found.";

            if (result.rows.length) {

                description =
                    result.rows.map(row => {

                        return (
                            `**${row.action}** — ` +
                            `<t:${Math.floor(
                                new Date(row.created_at).getTime() / 1000
                            )}:R>\n` +
                            `Source: ${row.source || "Unknown"}\n`
                        );

                    }).join("\n");
            }

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLORS.purple)
                        .setTitle(
                            `📜 Authorization History — ${username}`
                        )
                        .setDescription(
                            description.slice(
                                0,
                                4000
                            )
                        )
                ],
                ephemeral: true
            });
        }

        // ====================================================
        // TICKET COMMANDS
        // ====================================================

        if (
            interaction.commandName ===
            "ticket"
        ) {

            const subcommand =
                interaction.options.getSubcommand();

            // ------------------------------------------------
            // SETUP
            // ------------------------------------------------

            if (
                subcommand ===
                "setup"
            ) {

                if (!isFinancialOperations(member)) {

                    return interaction.reply({
                        content:
                            "❌ Financial Operations only.",
                        ephemeral: true
                    });
                }

                const supportRole =
                    interaction.options.getRole(
                        "support_role"
                    );

                const managementRole =
                    interaction.options.getRole(
                        "management_role"
                    );

                const category =
                    interaction.options.getChannel(
                        "category"
                    );

                const logChannel =
                    interaction.options.getChannel(
                        "log_channel"
                    );

                const panelChannel =
                    interaction.options.getChannel(
                        "panel_channel"
                    );

                await saveTicketConfig(
                    interaction.guild.id,
                    {
                        support_role_id:
                            supportRole.id,

                        management_role_id:
                            managementRole.id,

                        category_id:
                            category.id,

                        log_channel_id:
                            logChannel.id,

                        panel_channel_id:
                            panelChannel.id,

                        panel_color:
                            COLORS.blue,

                        ticket_color:
                            COLORS.blue,

                        success_color:
                            COLORS.green,

                        error_color:
                            COLORS.red,

                        leaderboard_color:
                            COLORS.purple
                    }
                );

                return interaction.reply({
                    embeds: [
                        successEmbed(
                            "Ticket System Configured",
                            `**Support:** <@&${supportRole.id}>\n` +
                            `**Management:** <@&${managementRole.id}>\n` +
                            `**Category:** ${category}\n` +
                            `**Logs:** ${logChannel}\n` +
                            `**Panel:** ${panelChannel}`
                        )
                    ],
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // PANEL
            // ------------------------------------------------

            if (
                subcommand ===
                "panel"
            ) {

                if (!isFinancialOperations(member)) {

                    return interaction.reply({
                        content:
                            "❌ Financial Operations only.",
                        ephemeral: true
                    });
                }

                const config =
                    await getTicketConfig(
                        interaction.guild.id
                    );

                if (!config) {

                    return interaction.reply({
                        content:
                            "❌ Configure the ticket system first.",
                        ephemeral: true
                    });
                }

                const channel =
                    interaction.guild.channels.cache.get(
                        config.panel_channel_id
                    );

                if (!channel) {

                    return interaction.reply({
                        content:
                            "❌ Panel channel not found.",
                        ephemeral: true
                    });
                }

                const message =
                    await channel.send({
                        embeds: [
                            ticketPanelEmbed(
                                config
                            )
                        ],
                        components: [
                            ticketPanelButton()
                        ]
                    });

                await db(`
                    UPDATE ticket_config
                    SET
                        panel_message_id = $1
                    WHERE guild_id = $2
                `, [
                    message.id,
                    interaction.guild.id
                ]);

                return interaction.reply({
                    embeds: [
                        successEmbed(
                            "Panel Sent",
                            `The ticket panel has been sent to ${channel}.`
                        )
                    ],
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // CLAIM
            // ------------------------------------------------

            if (
                subcommand ===
                "claim"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to claim tickets.",
                        ephemeral: true
                    });
                }

                const ticket =
                    await requireTicket(
                        interaction
                    );

                if (!ticket) {

                    return interaction.reply({
                        content:
                            "❌ This channel is not a ticket.",
                        ephemeral: true
                    });
                }

                if (ticket.claimer_id) {

                    return interaction.reply({
                        content:
                            `❌ This ticket is already claimed by <@${ticket.claimer_id}>.`,
                        ephemeral: true
                    });
                }

                await db(`
                    UPDATE tickets
                    SET
                        claimer_id = $1,
                        status = 'claimed',
                        claimed_at = NOW()
                    WHERE channel_id = $2
                `, [
                    interaction.user.id,
                    interaction.channel.id
                ]);

                await applyClaimPermissions(
                    interaction.channel,
                    interaction.user.id
                );

                await addClaim(
                    interaction.channel.id,
                    interaction.user.id
                );

                await addTicketHistory(
                    interaction.channel.id,
                    interaction.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "TICKET_CLAIMED",
                    "Ticket claimed."
                );

                await interaction.reply({
                    embeds: [
                        successEmbed(
                            "Ticket Claimed",
                            `<@${interaction.user.id}> is now handling this ticket.\n\n` +
                            "Only the client and assigned staff member can speak unless another staff member is approved through **Request to Join**."
                        )
                    ]
                });

                await refreshTicketPanel(
                    interaction.channel
                );

                await updateLeaderboard(
                    interaction.guild
                );

                return;
            }

            // ------------------------------------------------
            // UNCLAIM
            // ------------------------------------------------

            if (
                subcommand ===
                "unclaim"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to unclaim tickets.",
                        ephemeral: true
                    });
                }

                const ticket =
                    await requireTicket(
                        interaction
                    );

                if (!ticket) {

                    return interaction.reply({
                        content:
                            "❌ This channel is not a ticket.",
                        ephemeral: true
                    });
                }

                if (!ticket.claimer_id) {

                    return interaction.reply({
                        content:
                            "❌ This ticket is not claimed.",
                        ephemeral: true
                    });
                }

                if (
                    ticket.claimer_id !==
                    interaction.user.id &&
                    !(await isManagement(member))
                ) {

                    return interaction.reply({
                        content:
                            "❌ Only the assigned staff member or Management can unclaim this ticket.",
                        ephemeral: true
                    });
                }

                await db(`
                    UPDATE tickets
                    SET
                        claimer_id = NULL,
                        status = 'open',
                        claimed_at = NULL
                    WHERE channel_id = $1
                `, [
                    interaction.channel.id
                ]);

                await restoreUnclaimedPermissions(
                    interaction.channel
                );

                await db(`
                    DELETE FROM ticket_joiners
                    WHERE channel_id = $1
                `, [
                    interaction.channel.id
                ]);

                await addTicketHistory(
                    interaction.channel.id,
                    interaction.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "TICKET_UNCLAIMED",
                    "Ticket unclaimed."
                );

                await interaction.reply({
                    embeds: [
                        successEmbed(
                            "Ticket Unclaimed",
                            "The ticket is available for another staff member."
                        )
                    ]
                });

                await refreshTicketPanel(
                    interaction.channel
                );

                return;
            }

            // ------------------------------------------------
            // TRANSFER
            // ------------------------------------------------

            if (
                subcommand ===
                "transfer"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to transfer tickets.",
                        ephemeral: true
                    });
                }

                const ticket =
                    await requireTicket(
                        interaction
                    );

                if (!ticket) {

                    return interaction.reply({
                        content:
                            "❌ This channel is not a ticket.",
                        ephemeral: true
                    });
                }

                const target =
                    interaction.options.getUser(
                        "user"
                    );

                const reason =
                    interaction.options.getString(
                        "reason"
                    ) || "";

                if (
                    target.id ===
                    interaction.user.id
                ) {

                    return interaction.reply({
                        content:
                            "❌ You cannot transfer a ticket to yourself.",
                        ephemeral: true
                    });
                }

                const targetMember =
                    await interaction.guild.members.fetch(
                        target.id
                    ).catch(() => null);

                if (!targetMember) {

                    return interaction.reply({
                        content:
                            "❌ That user is not in this server.",
                        ephemeral: true
                    });
                }

                if (!(await isSupport(targetMember)) &&
                    !(await isManagement(targetMember))) {

                    return interaction.reply({
                        content:
                            "❌ That user is not Support or Management.",
                        ephemeral: true
                    });
                }

                const request =
                    await createTransferRequest(
                        interaction.channel,
                        interaction.user,
                        target,
                        reason
                    );

                if (request.alreadyPending) {

                    return interaction.reply({
                        content:
                            "❌ There is already a pending transfer request for that staff member.",
                        ephemeral: true
                    });
                }

                await interaction.channel.send({
                    content:
                        `<@${target.id}>`,

                    embeds: [
                        transferRequestEmbed(
                            interaction.channel,
                            interaction.user,
                            target,
                            reason
                        )
                    ],

                    components: [
                        transferButtons(
                            request.requestId
                        )
                    ]
                });

                return interaction.reply({
                    content:
                        "✅ Transfer request sent. Only the selected staff member can accept or deny it.",
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // RENAME
            // ------------------------------------------------

            if (
                subcommand ===
                "rename"
            ) {

                if (!(await isSupport(member))) {

                    return interaction.reply({
                        content:
                            "❌ Support only.",
                        ephemeral: true
                    });
                }

                const ticket =
                    await requireTicket(
                        interaction
                    );

                if (!ticket) {

                    return interaction.reply({
                        content:
                            "❌ This channel is not a ticket.",
                        ephemeral: true
                    });
                }

                let name =
                    interaction.options.getString(
                        "name"
                    );

                name = name
                    .toLowerCase()
                    .replace(/[^a-z0-9-_]/g, "-")
                    .replace(/-+/g, "-")
                    .slice(0, 90);

                if (!name) {

                    return interaction.reply({
                        content:
                            "❌ Invalid ticket name.",
                        ephemeral: true
                    });
                }

                await interaction.channel.setName(
                    name
                );

                await addTicketHistory(
                    interaction.channel.id,
                    interaction.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "TICKET_RENAMED",
                    name
                );

                return interaction.reply({
                    embeds: [
                        successEmbed(
                            "Ticket Renamed",
                            `The ticket is now **${name}**.`
                        )
                    ]
                });
            }

            // ------------------------------------------------
            // ADD USER
            // ------------------------------------------------

            if (
                subcommand ===
                "add"
            ) {

                if (!(await isSupport(member))) {

                    return interaction.reply({
                        content:
                            "❌ Support only.",
                        ephemeral: true
                    });
                }

                const user =
                    interaction.options.getUser(
                        "user"
                    );

                await interaction.channel.permissionOverwrites.edit(
                    user.id,
                    {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true,
                        AttachFiles: true
                    }
                );

                await addTicketHistory(
                    interaction.channel.id,
                    interaction.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "USER_ADDED",
                    `<@${user.id}>`
                );

                return interaction.reply({
                    embeds: [
                        successEmbed(
                            "User Added",
                            `<@${user.id}> has been added to this ticket.`
                        )
                    ]
                });
            }

            // ------------------------------------------------
            // REMOVE USER
            // ------------------------------------------------

            if (
                subcommand ===
                "remove"
            ) {

                if (!(await isSupport(member))) {

                    return interaction.reply({
                        content:
                            "❌ Support only.",
                        ephemeral: true
                    });
                }

                const user =
                    interaction.options.getUser(
                        "user"
                    );

                const ticket =
                    await requireTicket(
                        interaction
                    );

                if (
                    user.id ===
                    ticket?.opener_id
                ) {

                    return interaction.reply({
                        content:
                            "❌ You cannot remove the ticket client.",
                        ephemeral: true
                    });
                }

                await interaction.channel.permissionOverwrites.delete(
                    user.id
                ).catch(() => {});

                await addTicketHistory(
                    interaction.channel.id,
                    interaction.guild.id,
                    interaction.user.id,
                    interaction.user.tag,
                    "USER_REMOVED",
                    `<@${user.id}>`
                );

                return interaction.reply({
                    embeds: [
                        successEmbed(
                            "User Removed",
                            `<@${user.id}> has been removed from this ticket.`
                        )
                    ]
                });
            }

            // ------------------------------------------------
            // CLOSE
            // ------------------------------------------------

            if (
                subcommand ===
                "close"
            ) {

                if (!(await canManageTickets(member))) {

                    return interaction.reply({
                        content:
                            "❌ You do not have permission to close tickets.",
                        ephemeral: true
                    });
                }

                return interaction.reply({
                    embeds: [
                        closePanelEmbed()
                    ],
                    components: [
                        closePanelButtons()
                    ],
                    ephemeral: true
                });
            }

            // ------------------------------------------------
            // FORCE CLOSE
            // ------------------------------------------------

            if (
                subcommand ===
                "forceclose"
            ) {

                if (!(await isManagement(member))) {

                    return interaction.reply({
                        content:
                            "❌ Management only.",
                        ephemeral: true
                    });
                }

                const ticket =
                    await requireTicket(
                        interaction
                    );

                if (!ticket) {

                    return interaction.reply({
                        content:
                            "❌ This channel is not a ticket.",
                            ephemeral: true
                    });
                }

                await interaction.reply({
                    content:
                        "🔴 Force closing ticket..."
                });

                await finishTicketClose(
                    interaction.channel,
                    "Force Closed",
                    interaction.user
                );

                return;
            }
        }

        // ====================================================
        // ESCALATE
        // ====================================================

        if (
            interaction.commandName ===
            "escalate"
        ) {

            if (!(await canManageTickets(member))) {

                return interaction.reply({
                    content:
                        "❌ You do not have permission to escalate tickets.",
                    ephemeral: true
                });
            }

            const ticket =
                await requireTicket(
                    interaction
                );

            if (!ticket) {

                return interaction.reply({
                    content:
                        "❌ This channel is not a ticket.",
                    ephemeral: true
                });
            }

            await db(`
                UPDATE tickets
                SET
                    status = 'escalated',
                    escalated_by = $1,
                    escalated_at = NOW()
                WHERE channel_id = $2
            `, [
                interaction.user.id,
                interaction.channel.id
            ]);

            await addTicketHistory(
                interaction.channel.id,
                interaction.guild.id,
                interaction.user.id,
                interaction.user.tag,
                "ESCALATED",
                "Ticket escalated."
            );

            await interaction.channel.send({
                content:
                    `<@&${MANAGER_ROLE_ID}>`,

                embeds: [
                    new EmbedBuilder()
                        .setColor(COLORS.red)
                        .setTitle(
                            "🚨 Ticket Escalated"
                        )
                        .setDescription(
                            `<@${interaction.user.id}> has escalated this ticket to Management.`
                        )
                        .setTimestamp()
                ]
            });

            await interaction.reply({
                content:
                    "🚨 Ticket escalated.",
                ephemeral: true
            });

            await refreshTicketPanel(
                interaction.channel
            );

            return;
        }

        // ====================================================
        // STATS
        // ====================================================

        if (
            interaction.commandName ===
            "stats"
        ) {

            if (!(await canManageTickets(member))) {

                return interaction.reply({
                    content:
                        "❌ You do not have permission to view statistics.",
                    ephemeral: true
                });
            }

            const stats =
                await getTicketStats(
                    interaction.guild.id
                );

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLORS.purple)
                        .setTitle(
                            "📊 Ticket Statistics"
                        )
                        .addFields(
                            {
                                name: "🎫 Total",
                                value:
                                    String(stats.total),
                                inline: true
                            },
                            {
                                name: "🟢 Open",
                                value:
                                    String(stats.open),
                                inline: true
                            },
                            {
                                name: "🔵 Claimed",
                                value:
                                    String(stats.claimed),
                                inline: true
                            },
                            {
                                name: "🔴 Closed",
                                value:
                                    String(stats.closed),
                                inline: true
                            }
                        )
                        .setTimestamp()
                ],
                ephemeral: true
            });
        }

        // ====================================================
        // WIPE TICKETS
        // ====================================================

        if (
            interaction.commandName ===
            "wipetickets"
        ) {

            if (!isFinancialOperations(member)) {

                return interaction.reply({
                    content:
                        "❌ Financial Operations only.",
                    ephemeral: true
                });
            }

            const user =
                interaction.options.getUser(
                    "user"
                );

            await wipeClaims(
                user.id
            );

            for (const guild of client.guilds.cache.values()) {

                await updateLeaderboard(
                    guild
                ).catch(() => {});
            }

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "Claims Wiped",
                        `Ticket claim statistics for <@${user.id}> have been wiped.`
                    )
                ],
                ephemeral: true
            });
        }

    } catch (error) {

        console.error(
            "[INTERACTION ERROR]",
            error
        );

        if (interaction.replied ||
            interaction.deferred) {

            await interaction.editReply({
                content:
                    "❌ An unexpected error occurred."
            }).catch(() => {});

        } else {

            await interaction.reply({
                content:
                    "❌ An unexpected error occurred.",
                ephemeral: true
            }).catch(() => {});
        }
    }
});

// ============================================================
// MESSAGE CREATE
// FEEDBACK DM SYSTEM
// ============================================================

client.on("messageCreate", async message => {

    try {

        if (message.author.bot) {
            return;
        }

        // Only process DMs.
        if (message.guild) {
            return;
        }

        const data =
            pendingFeedback.get(
                message.author.id
            );

        if (!data) {
            return;
        }

        const channel =
            client.channels.cache.get(
                data.channelId
            );

        if (!channel) {

            pendingFeedback.delete(
                message.author.id
            );

            return;
        }

        const feedback =
            message.content.trim();

        if (!feedback) {
            return;
        }

        await db(`
            INSERT INTO ticket_feedback (
                channel_id,
                guild_id,
                user_id,
                staff_id,
                feedback
            )
            VALUES ($1,$2,$3,$4,$5)
        `, [
            data.channelId,
            data.guildId,
            data.userId,
            data.staffId || null,
            feedback
        ]);

        const feedbackChannel =
            client.channels.cache.get(
                FEEDBACK_CHANNEL_ID
            );

        if (feedbackChannel) {

            await feedbackChannel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLORS.green)
                        .setTitle(
                            "💬 New Ticket Feedback"
                        )
                        .addFields(
                            {
                                name: "Client",
                                value:
                                    `<@${data.userId}>`,
                                inline: true
                            },
                            {
                                name: "Staff",
                                value:
                                    data.staffId
                                        ? `<@${data.staffId}>`
                                        : "Unknown",
                                inline: true
                            },
                            {
                                name: "Ticket",
                                value:
                                    `<#${data.channelId}>`,
                                inline: true
                            },
                            {
                                name: "Feedback",
                                value:
                                    feedback.slice(
                                        0,
                                        4000
                                    )
                            }
                        )
                        .setTimestamp()
                ]
            }).catch(() => {});
        }

        pendingFeedback.delete(
            message.author.id
        );

        pendingCloseChoice.set(
            message.author.id,
            data
        );

        await message.author.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.blue)
                    .setTitle(
                        "💬 Feedback Received"
                    )
                    .setDescription(
                        "Thank you for your feedback.\n\n" +
                        "Would you like the ticket permanently closed or would you like to keep it open?"
                    )
                    .setTimestamp()
            ],
            components: [
                closeChoiceButtons()
            ]
        });

    } catch (error) {

        console.error(
            "[FEEDBACK ERROR]",
            error
        );
    }
});

// ============================================================
// API
// ============================================================

app.get("/check", async (req, res) => {

    try {

        const username =
            req.query.username;

        if (!username) {

            return res.status(400).json({
                error: "Missing username"
            });
        }

        const result =
            await db(`
                SELECT
                    roblox_username,
                    roblox_user_id,
                    authorized,
                    rban,
                    premium,
                    authorization_source,
                    authorized_at
                FROM authorizations
                WHERE LOWER(roblox_username)
                = LOWER($1)
                LIMIT 1
            `, [
                username
            ]);

        if (!result.rows.length) {

            return res.json({
                found: false,
                authorized: false,
                premium: false,
                rban: false
            });
        }

        const user =
            result.rows[0];

        return res.json({
            found: true,
            username:
                user.roblox_username,
            roblox_user_id:
                user.roblox_user_id,
            authorized:
                user.authorized,
            premium:
                user.premium,
            rban:
                user.rban,
            source:
                user.authorization_source,
            authorized_at:
                user.authorized_at
        });

    } catch (error) {

        console.error(
            "[API CHECK]",
            error
        );

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

// ============================================================
// BADGE AUTHORIZE
// ============================================================

app.post("/badge-authorize", async (req, res) => {

    try {

        const secret =
            req.headers["x-api-secret"];

        if (
            !secret ||
            secret !== API_SECRET
        ) {

            return res.status(401).json({
                error: "Unauthorized"
            });
        }

        const {
            username,
            userId
        } = req.body;

        if (!username || !userId) {

            return res.status(400).json({
                error:
                    "Missing username or userId"
            });
        }

        await saveAuthorization(
            username,
            String(userId),
            true,
            "Roblox Badge",
            "Roblox"
        );

        return res.json({
            success: true,
            authorized: true
        });

    } catch (error) {

        console.error(
            "[BADGE AUTHORIZE]",
            error
        );

        return res.status(500).json({
            error:
                "Internal server error"
        });
    }
});

// ============================================================
// API ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {

    console.error(
        "[EXPRESS ERROR]",
        err
    );

    res.status(500).json({
        error:
            "Internal server error"
    });
});

// ============================================================
// START API
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `[WEB] API listening on port ${PORT}`
        );
    }
);

// ============================================================
// LOGIN
// ============================================================

client.login(TOKEN)
    .then(() => {

        console.log(
            "[DISCORD] Login successful."
        );

    })
    .catch(error => {

        console.error(
            "[DISCORD LOGIN ERROR]",
            error
        );
    });

// ============================================================
// END OF PART 2
// ============================================================
