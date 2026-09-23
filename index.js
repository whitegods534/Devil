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



const app = express();



app.use(express.json());

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



/* DEAD SIGNAL OPERATIONS */

const FINANCIAL_OPERATIONS_ROLE_ID = "1551601783581843497";
const DEAD_SIGNAL_OPERATIONS_ROLE_ID = "1544699781547434014";



const LEADERBOARD_CHANNEL_ID = "1551976849385586759";

const FEEDBACK_CHANNEL_ID = "1551996605719380128";



const pendingFeedback = new Map();

const pendingClose = new Map();
const pendingCloseChoice = new Map();



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



function colorOption(option, name, description, defaultColor = "blue") {

    return option
        .setName(name)
        .setDescription(description)
        .setRequired(true)
        .addChoices(
            { name: "Blue", value: "blue" },
            { name: "Purple", value: "purple" },
            { name: "Green", value: "green" },
            { name: "Red", value: "red" },
            { name: "Orange", value: "orange" },
            { name: "Pink", value: "pink" },
            { name: "Cyan", value: "cyan" },
            { name: "Dark", value: "dark" }
        );
}

function getColor(name, fallback = "blue") {

    if (typeof name === "number") return name;

    if (typeof name === "string" && /^\d+$/.test(name)) {
        return Number(name);
    }

    return COLORS[name] || COLORS[fallback] || COLORS.blue;

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

const db = query;

async function saveTicketConfig(guildId, config) {
    await query(`
        INSERT INTO ticket_config (guild_id, support_role_id, management_role_id, category_id, log_channel_id, panel_color, ticket_color, success_color, error_color, leaderboard_color, panel_channel_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (guild_id) DO UPDATE SET
            support_role_id=EXCLUDED.support_role_id, management_role_id=EXCLUDED.management_role_id, category_id=EXCLUDED.category_id,
            log_channel_id=EXCLUDED.log_channel_id, panel_channel_id=EXCLUDED.panel_channel_id, panel_color=EXCLUDED.panel_color,
            ticket_color=EXCLUDED.ticket_color, success_color=EXCLUDED.success_color, error_color=EXCLUDED.error_color, leaderboard_color=EXCLUDED.leaderboard_color
    `, [guildId, config.support_role_id, config.management_role_id, config.category_id, config.log_channel_id,
        String(config.panel_color ?? COLORS.blue), String(config.ticket_color ?? COLORS.blue), String(config.success_color ?? COLORS.green), String(config.error_color ?? COLORS.red), String(config.leaderboard_color ?? COLORS.purple), config.panel_channel_id]);
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

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            PRIMARY KEY (channel_id, user_id)

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

    await query(`
        ALTER TABLE ticket_join_requests
        ADD COLUMN IF NOT EXISTS id BIGSERIAL
    `);

    await query(`
        ALTER TABLE ticket_join_requests
        ADD COLUMN IF NOT EXISTS guild_id TEXT
    `);

    await query(`
        ALTER TABLE ticket_join_requests
        ADD COLUMN IF NOT EXISTS reason TEXT
    `);

    await query(`
        ALTER TABLE ticket_join_requests
        ADD COLUMN IF NOT EXISTS decided_by TEXT
    `);

    await query(`
        ALTER TABLE ticket_join_requests
        ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS ticket_history (
            id BIGSERIAL PRIMARY KEY,
            channel_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            user_id TEXT,
            user_tag TEXT,
            action TEXT NOT NULL,
            details TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
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

    return hasRole(

        member,

        FINANCIAL_OPERATIONS_ROLE_ID

    );

}

function isDeadSignalOperations(member) {
    return hasRole(member, DEAD_SIGNAL_OPERATIONS_ROLE_ID);
}



function isClaimStaff(member) {
    return hasRole(member, CLAIM_ROLE_ID);
}

function canManageTickets(member, config) {
    return (
        isClaimStaff(member) ||
        isManagement(member, config) ||
        isSupport(member)
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
   AUTHORIZATION HELPERS 
========================================================= */ 
 
async function saveAuthorization(arg1, arg2, arg3 = true, arg4 = "manual", arg5 = "system") {
    let robloxUsername;
    let robloxUserId;
    let discordUserId;
    let source;
    let authorizedBy;
    let authorized = true;

    if (arg1 && typeof arg1 === "object") {
        ({ robloxUsername, robloxUserId, discordUserId, source, authorizedBy, authorized = true } = arg1);
    } else {
        robloxUsername = arg1;
        robloxUserId = arg2;
        authorized = arg3;
        source = arg4;
        authorizedBy = arg5;
        discordUserId = arg5;
    } 
 
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
 
function ticketEmbed( 
    config, 
    ticket, 
    opener 
) { 
 
    const color = getColor( 
        config?.ticket_color || "blue" 
    ); 
 
    let status = 
        ticket.status?.toUpperCase() || 
        "OPEN"; 
 
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
 
        embed.setThumbnail( 
            opener.displayAvatarURL() 
        ); 
    } 
 
    return embed; 
} 
 
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
                .setCustomId("ticket_unclaim") 
                .setLabel("Unclaim") 
                .setEmoji("↩️") 
                .setStyle(ButtonStyle.Secondary), 
 
            new ButtonBuilder() 
                 .setCustomId("ticket_join") 
                .setLabel("Request to Join") 
                .setEmoji("👥") 
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
 
function joinRequestButtons(userId) { 
 
    return new ActionRowBuilder() 
        .addComponents( 
 
            new ButtonBuilder() 
                .setCustomId( 
                    `ticket_join_approve:${userId}` 
                ) 
                .setLabel("Approve") 
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
 
function closePanelEmbed() {
    return new EmbedBuilder()
        .setColor(COLORS.red)
        .setTitle('🔒 Close Ticket')
        .setDescription('Choose how you want to close this ticket.')
        .setTimestamp();
}

function closePanelButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('close_reason_afk')
            .setLabel('Client is AFK')
            .setEmoji('😴')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('close_reason_handled')
            .setLabel('Handled')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('close_cancel')
            .setLabel('Cancel')
            .setEmoji('↩️')
            .setStyle(ButtonStyle.Secondary)
    );
}

function closeChoiceButtons() { 
 
    return new ActionRowBuilder() 
        .addComponents( 
 
            new ButtonBuilder() 
                .setCustomId("feedback_close_yes") 
                .setLabel("Yes, close it") 
                .setEmoji("🔒") 
                .setStyle(ButtonStyle.Success), 
 
            new ButtonBuilder() 
                .setCustomId("feedback_close_no") 
                .setLabel("No, keep it open") 
                .setEmoji("↩️") 
                .setStyle(ButtonStyle.Secondary) 
        ); 
} 
 
/* =========================================================
   TICKET CORE HELPERS
========================================================= */

async function addTicketHistory(channelId, guildId, userId, userTag, action, details = "") {
    await query(`
        INSERT INTO ticket_history (channel_id, guild_id, user_id, user_tag, action, details)
        VALUES ($1,$2,$3,$4,$5,$6)
    `, [channelId, guildId, userId, userTag, action, details]).catch(error => {
        console.error("[TICKET HISTORY ERROR]", error.message);
    });
}

async function getJoinedStaffCount(channelId) {
    const result = await query(`
        SELECT COUNT(*)::int AS count
        FROM ticket_join_requests
        WHERE channel_id = $1 AND status = 'accepted'
    `, [channelId]);
    return Number(result.rows[0]?.count || 0);
}

async function allowJoinedStaff(channel, userId) {
    await channel.permissionOverwrites.edit(userId, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
        AttachFiles: true, EmbedLinks: true
    });
}

async function applyClaimPermissions(channel, claimerId) {
    const ticket = await getCurrentTicket(channel.id);
    const config = ticket ? await getTicketConfig(ticket.guild_id) : null;
    await channel.permissionOverwrites.edit(CLAIM_ROLE_ID, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => {});
    await channel.permissionOverwrites.edit(SUPPORT_ROLE_ID, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => {});
    if (config?.management_role_id) {
        await channel.permissionOverwrites.edit(config.management_role_id, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => {});
    }
    await channel.permissionOverwrites.edit(claimerId, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
        AttachFiles: true, EmbedLinks: true, AddReactions: true
    });
}

async function refreshTicketPanel(channel) {
    return refreshTicketMessage(channel);
}

async function closeTicketAFK(channel, staffUser) {
    const ticket = await getCurrentTicket(channel.id);
    if (!ticket) throw new Error("This channel is not a ticket.");
    await query(`UPDATE tickets SET status='closed', closed_at=NOW() WHERE channel_id=$1`, [channel.id]);
    await query(`DELETE FROM ticket_join_requests WHERE channel_id=$1`, [channel.id]).catch(() => {});
    await addTicketHistory(channel.id, channel.guild.id, staffUser.id, staffUser.tag, "CLOSED_AFK", "Client was marked AFK.");
    const config = await getTicketConfig(channel.guild.id);
    await logTicket(channel.guild, config, "Ticket Closed — AFK", `${staffUser} closed ${channel} because the client was AFK.`, "red");
    setTimeout(() => channel.delete("Ticket closed — client AFK").catch(() => {}), 1500);
}

async function closeTicketHandled(channel, staffUser) {
    const ticket = await getCurrentTicket(channel.id);
    if (!ticket) throw new Error("This channel is not a ticket.");
    await query(`UPDATE tickets SET status='closed', closed_at=NOW() WHERE channel_id=$1`, [channel.id]);
    await addTicketHistory(channel.id, channel.guild.id, staffUser.id, staffUser.tag, "CLOSED_HANDLED", "Ticket marked handled and feedback requested.");
    const config = await getTicketConfig(channel.guild.id);
    await logTicket(channel.guild, config, "Ticket Closed — Handled", `${staffUser} marked ${channel} as handled and requested feedback.`, "green");
    await requestTicketFeedback(channel.guild, channel, ticket);
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
 
        setTimeout(async () => { 
 
            await channel 
                .delete() 
                .catch(() => {}); 
 
        }, 10 * 60 * 1000); 
 
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
 
        const timeout = 
            setTimeout(async () => { 
 
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
 
                await channel 
                    .delete() 
                    .catch(() => {}); 
 
            }, 10 * 60 * 1000); 
 
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
 
        setTimeout(async () => { 
 
            await channel 
                .delete() 
                .catch(() => {}); 
 
        }, 10 * 60 * 1000); 
    } 
} 
 
async function sendFeedbackToStaff( 
    message, 
    feedback 
) { 
 
    const feedbackChannel = 
        await client.channels 
            .fetch(FEEDBACK_CHANNEL_ID) 
            .catch(() => null); 
 
    const embed = 
        new EmbedBuilder() 
            .setTitle( 
                "⭐ New Ticket Feedback" 
            ) 
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
 
        await feedbackChannel 
            .send({ 
                content: 
                    `<@${feedback.staffId}>`, 
                embeds: [embed] 
            }) 
            .catch(() => {}); 
    } 
 
    const staffUser = 
        await client.users 
            .fetch(feedback.staffId) 
            .catch(() => null); 
 
    if (staffUser) { 
 
        await staffUser 
            .send({ 
                embeds: [embed] 
            }) 
            .catch(() => {}); 
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
 
    await channel 
        .delete() 
        .catch(() => {}); 
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
 
    const embed = 
        new EmbedBuilder() 
            .setTitle(title) 
            .setDescription(description) 
            .setColor( 
                getColor(color) 
            ) 
            .setTimestamp(); 
 
    await channel 
        .send({ 
            embeds: [embed] 
        }) 
        .catch(() => {}); 
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
 
        console.log( 
            `[LEADERBOARD] Channel ${LEADERBOARD_CHANNEL_ID} not found in ${guild.name}` 
        ); 
 
        return; 
    } 
 
    const result = 
        await query( 
            ` 
            SELECT user_id, 
                   user_tag, 
                   count 
            FROM ticket_claims 
            WHERE guild_id = $1 
            ORDER BY count DESC 
            LIMIT 10 
            `, 
            [guild.id] 
        ); 
 
    const rows = 
        result.rows; 
 
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
 
                    if (position === 1) 
                        medal = "🥇"; 
 
                    if (position === 2) 
                        medal = "🥈"; 
 
                    if (position === 3) 
                        medal = "🥉"; 
 
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
                text: 
                    "Devil Support" 
            }) 
            .setTimestamp(); 
 
    let message = null; 
 
    if ( 
        config.leaderboard_message_id 
    ) { 
 
        message = 
            await channel.messages 
                .fetch( 
                    config.leaderboard_message_id 
                ) 
                .catch(() => null); 
    } 
 
    if (message) { 
 
        await message 
            .edit({ 
                embeds: [embed] 
            }) 
            .catch(() => {}); 
 
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
   SLASH COMMANDS 
========================================================= */ 
 
const commands = [
    new SlashCommandBuilder()
        .setName("cmdshelp")
        .setDescription("Show the available bot commands")
];

/* ========================================================= 
   REGISTER COMMANDS 
========================================================= */ 
 
client.once( 
    "clientReady", 
    async () => { 
 
        console.log( 
            `[DISCORD] Logged in as ${client.user.tag}` 
        ); 
 
        try { 
 
            await setupDatabase(); 
 
            await client.application 
                .commands 
                .set(commands); 
 
            console.log( 
                "[DISCORD] Commands registered" 
            ); 
 
            console.log( 
                `[DISCORD] Badge ID: ${BADGE_ID}` 
            ); 
 
            setInterval( 
                async () => { 
 
                    for ( 
                        const guild 
                        of client.guilds.cache.values() 
                    ) { 
 
                        await updateLeaderboard( 
                            guild 
                        ).catch(error => { 
 
                            console.error( 
                                "[LEADERBOARD ERROR]", 
                                error.message 
                            ); 
 
                        }); 
                    } 
 
                }, 
                30 * 60 * 1000 
            );

            // Ticket V2: automatically remove database records for channels
            // that were deleted manually in Discord.
            await cleanupAllStaleTickets().catch(() => {});
            setInterval(() => {
                cleanupAllStaleTickets().catch(() => {});
            }, 2 * 60 * 1000); 
 
            for ( 
                const guild 
                of client.guilds.cache.values() 
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
 
            /* ================================================ 
               BUTTONS 
            ================================================ */ 
 
            if (interaction.isButton()) { 
 
                if ( 
                    interaction.customId === 
                    "ticket_create" 
                ) { 
                    return; 
                } 
 
                const guild = 
                    interaction.guild; 
 
                if (!guild) return; 
 
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
                        `SELECT * FROM tickets WHERE channel_id = $1`, 
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
 
                /* CLAIM */ 
 
                if ( 
                    interaction.customId === 
                    "ticket_claim" 
                ) { 
 
                    if ( 
                        !isClaimStaff(interaction.member) &&
                        !isManagement(interaction.member, config)
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
 
                    const claimResult = await query(
                        `
                        UPDATE tickets
                        SET claimer_id = $1,
                            claimed_at = NOW(),
                            status = 'claimed'
                        WHERE channel_id = $2
                          AND status <> 'closed'
                          AND claimer_id IS NULL
                        RETURNING channel_id
                        `,
                        [interaction.user.id, interaction.channel.id]
                    );

                    if (!claimResult.rows.length) {
                        const current = await getCurrentTicket(interaction.channel.id);
                        return interaction.reply({
                            embeds: [errorEmbed(
                                'Already Claimed',
                                current?.claimer_id
                                    ? `This ticket is already claimed by <@${current.claimer_id}>. Use **Request to Join** if you need access.`
                                    : 'This ticket could not be claimed. Please try again.'
                            )],
                            ephemeral: true
                        });
                    } 
 
                    await addClaim( 
                        guild.id, 
                        interaction.user.id, 
                        interaction.user.tag 
                    ); 
 
                    /* 
                       When claimed, staff roles lose 
                       SendMessages permission. 
                    */ 
 
                    await interaction.channel 
                        .permissionOverwrites 
                        .edit( 
                            SUPPORT_ROLE_ID, 
                            { 
                                ViewChannel: true, 
                                SendMessages: false, 
                                ReadMessageHistory: true 
                            } 
                        ) 
                        .catch(() => {});

                    await interaction.channel.permissionOverwrites.edit(
                        CLAIM_ROLE_ID,
                        { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }
                    ).catch(() => {}); 
 
                    await interaction.channel 
                        .permissionOverwrites 
                        .edit( 
                            config.management_role_id, 
                            { 
                                ViewChannel: true, 
                                SendMessages: false, 
                                ReadMessageHistory: true 
                            } 
                        ) 
                        .catch(() => {}); 
 
                    /* 
                       Claimer can talk. 
                    */ 
 
                    await interaction.channel 
                        .permissionOverwrites 
                        .edit( 
                            interaction.user.id, 
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
                    await refreshTicketMessage(interaction.channel);
 
                    return; 
                } 
 
                /* REQUEST TO JOIN */ 
 
                if ( 
                    interaction.customId === "ticket_join_request" ||
                    interaction.customId === "ticket_join"
                ) { 
 
                    if ( 
                        !isClaimStaff(interaction.member) &&
                        !isManagement(interaction.member, config) 
                    ) { 
 
                        return interaction.reply({ 
                            embeds: [ 
                                errorEmbed( 
                                    "No Permission", 
                                    "Only staff can request to join a claimed ticket." 
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
 
                    await query( 
                        ` 
                        INSERT INTO ticket_join_requests ( 
                            channel_id, 
                            user_id, 
                            user_tag, 
                            status 
                        ) 
                        VALUES ($1,$2,$3,'pending') 
                        ON CONFLICT ( 
                            channel_id, 
                            user_id 
                        ) 
                        DO UPDATE SET 
                            status='pending', 
                            user_tag=EXCLUDED.user_tag, 
                            created_at=NOW() 
                        `, 
                        [ 
                            interaction.channel.id, 
                            interaction.user.id, 
                            interaction.user.tag 
                        ] 
                    ); 
 
                    await interaction.reply({ 
                        content: 
                            `<@${ticket.claimer_id}>`, 
                        embeds: [ 
                            new EmbedBuilder() 
                                .setTitle( 
                                    "👥 Join Request" 
                                ) 
                                .setDescription( 
                                    `${interaction.user} has requested to join this ticket.` 
                                ) 
                                .setColor( 
                                    getColor( 
                                        "purple" 
                                    ) 
                                ) 
                                .setTimestamp() 
                        ], 
                        components: [ 
                            joinRequestButtons( 
                                interaction.user.id 
                            ) 
                        ] 
                    }); 
 
                    return; 
                } 
 
                /* 
                   ONLY CLAIMER OR MANAGEMENT 
                   CAN APPROVE/DENY JOIN REQUESTS 
                */ 
 
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
                        await client.users 
                            .fetch( 
                                requestedUserId 
                            ) 
                            .catch(() => null); 
 
                    if (!requestedUser) { 
 
                        return interaction.reply({ 
                            content: 
                                "User not found.", 
                            ephemeral: true 
                        }); 
                    } 
 
                    if (approve) { 
 
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
                            SET status='approved' 
                            WHERE channel_id=$1 
                            AND user_id=$2 
                            `, 
                            [ 
                                interaction.channel.id, 
                                requestedUserId 
                            ] 
                        ); 
 
                        await interaction.update({ 
                            content: 
                                `✅ ${requestedUser} has been approved to join this ticket.`, 
                            components: [] 
                        }); 
 
                    } else { 
 
                        await query( 
                            ` 
                            UPDATE ticket_join_requests 
                            SET status='denied' 
                            WHERE channel_id=$1 
                            AND user_id=$2 
                            `, 
                            [ 
                                interaction.channel.id, 
                                requestedUserId 
                            ] 
                        ); 
 
                        await interaction.update({ 
                            content: 
                                `❌ ${requestedUser}'s request to join was denied.`, 
                            components: [] 
                        }); 
                    } 
 
                    return; 
                } 
 
                /* ESCALATE */ 
 
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

                    const escalationCategory = guild.channels.cache.get(ESCALATED_CATEGORY_ID) ||
                        await guild.channels.fetch(ESCALATED_CATEGORY_ID).catch(() => null);
                    if (!escalationCategory || escalationCategory.type !== ChannelType.GuildCategory) {
                        return interaction.reply({ content: "❌ Escalation category was not found.", ephemeral: true });
                    }

                    await interaction.channel.setParent(escalationCategory.id, { lockPermissions: false });
                    await interaction.channel.permissionOverwrites.edit(SUPPORT_ROLE_ID, { ViewChannel: false, SendMessages: false, ReadMessageHistory: false }).catch(() => {});
                    await interaction.channel.permissionOverwrites.edit(CLAIM_ROLE_ID, { ViewChannel: false, SendMessages: false, ReadMessageHistory: false }).catch(() => {});
                    await interaction.channel.permissionOverwrites.edit(MANAGER_ROLE_ID, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
                    await interaction.channel.permissionOverwrites.edit(config.management_role_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
                    await interaction.channel.send({ content: `<@&${MANAGER_ROLE_ID}>`, embeds: [new EmbedBuilder().setTitle("⚠️ Ticket Escalated").setDescription(`${interaction.user} escalated this ticket. Support access has been removed.`).setColor(getColor("orange")).setTimestamp()] });

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
 
                /* CLOSE */ 
 
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
 
                    /* 
                       Close handling continues in Part 2. 
                    */ 
 
                    return interaction.reply({ 
                        embeds: [ 
                            new EmbedBuilder() 
                                .setTitle( 
                                    "🔒 Close Ticket" 
                                ) 
                                .setDescription( 
                                    "Please choose a close reason." 
                                ) 
                                .setColor( 
                                    getColor( 
                                        config.ticket_color 
                                    ) 
                                ) 
                        ], 
                        components: [ 
                            new ActionRowBuilder() 
                                .addComponents( 
    new ButtonBuilder() 
        .setCustomId("close_reason_afk") 
        .setLabel("Client is AFK") 
        .setEmoji("😴") 
        .setStyle(ButtonStyle.Danger), 
 
    new ButtonBuilder() 
        .setCustomId("close_reason_handled") 
        .setLabel("Handled") 
        .setEmoji("✅") 
        .setStyle(ButtonStyle.Success) 
) 
], 
ephemeral: true 
                    }); 
                } 
            } 
 
            /* ================================================ 
               CHAT INPUT COMMANDS 
            ================================================ */ 
 
            if (!interaction.isChatInputCommand()) { 
                return; 
            } 
 
            // Slash commands are handled by the second interaction handler below.
            if (interaction.isChatInputCommand()) {
                return;
            }

            return;

            const guild = 
                interaction.guild; 
 
            if (!guild) { 
 
                return interaction.reply({ 
                    content: 
                        "This command can only be used inside a server.", 
                    ephemeral: true 
                }); 
            } 
 
            /* ================================================ 
               CMDSHELP 
            ================================================ */ 
 
            if ( 
                interaction.commandName === 
                "cmdshelp" 
            ) { 
 
                const embed = 
                    new EmbedBuilder() 
                        .setTitle( 
                            "📚 Devil Bot Commands" 
                        ) 
                        .setDescription( 
                            "Here are the available commands." 
                        ) 
                        .addFields( 
 
                            { 
                                name: 
                                    "🔐 Authorization", 
                                value: 
                                    "`/auth <username>` — Authorize a Roblox user.\n" + 
                                    "`/check <username>` — Check authorization.\n" + 
                                    "`/profile <username>` — View a Roblox profile.\n" + 
                                    "`/history <username>` — View authorization history.", 
                                inline: false 
                            }, 
 
                            { 
                                name: 
                                    "🎫 Ticket Commands", 
                                value: 
                                    "`/ticket setup` — Setup the ticket system.\n" + 
                                    "`/ticket panel` — Send the ticket panel.\n" + 
                                    "`/ticket claim` — Claim a ticket.\n" + 
                                    "`/ticket unclaim` — Unclaim a ticket.\n" + 
                                    "`/ticket close` — Open the close panel.\n" + 
                                    "`/ticket forceclose` — Force close a ticket.\n" + 
                                    "`/ticket rename` — Rename a ticket.\n" + 
                                    "`/ticket add` — Add a user.\n" + 
                                    "`/ticket remove` — Remove a user.\n" + 
                                    "`/ticket transfer` — Request a ticket transfer.", 
                                inline: false 
                            }, 
 
                            { 
                                name: 
                                    "🛠️ Staff", 
                                value: 
                                    "`/escalate` — Escalate a ticket.\n" + 
                                    "`/stats` — View ticket statistics.\n" + 
                                    "`/wipetickets` — Wipe ticket claim statistics.", 
                                inline: false 
                            }, 
 
                            { 
                                name: 
                                    "🎛️ Ticket Control Panel", 
                                value: 
                                    "📌 Ticket Status\n" + 
                                    "☑️ Checklist\n" + 
                                    "🗂️ Ticket Tags\n" + 
                                    "📜 Ticket History\n" + 
                                    "📝 Internal Notes\n" + 
                                    "🔄 Ticket Transfer\n" + 
                                    "👥 Request to Join\n" + 
                                    "🔒 Close Panel", 
                                inline: false 
                            } 
                        ) 
                        .setColor( 
                            getColor("blue") 
                        ) 
                        .setFooter({ 
                            text: 
                                "Devil Support System" 
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
                                "You need DeadSignal Operations to use this command." 
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
 
                const user = 
                    await getRobloxUser( 
                        username 
                    ); 
 
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
 
            if ( 
                interaction.commandName === 
                "check" 
            ) { 
 
                const config = 
                    await getTicketConfig( 
                        guild.id 
                    ); 
 
                if ( 
                    !isFinancialOperations( 
                        interaction.member 
                    ) && 
                    !isSupport( 
                        interaction.member 
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
                                "You do not have permission to use this command." 
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
 
                const user = 
                    await getRobloxUser( 
                        username 
                    ); 
 
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
 
                const result = 
                    await query( 
                        ` 
                        SELECT * 
                        FROM authorizations 
                        WHERE roblox_user_id = $1 
                        `, 
                        [user.id] 
                    ); 
 
                const auth = 
                    result.rows[0]; 
 
                if (!auth) { 
 
                    return interaction.reply({ 
                        embeds: [ 
                            new EmbedBuilder() 
                                .setTitle( 
                                    "🔎 Authorization Check" 
                                ) 
                                .setDescription( 
                                    `**${user.name}** is not authorized.` 
                                ) 
                                .setColor( 
                                    getColor("red") 
                                ) 
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
                            .setTitle( 
                                "🔎 Authorization Check" 
                            ) 
                            .addFields( 
 
                                { 
                                    name: 
                                        "Roblox User", 
                                    value: 
                                        user.name, 
                                    inline: 
                                        true 
                                }, 
 
                                { 
                                    name: 
                                        "Roblox ID", 
                                    value: 
                                        String( 
                                            user.id 
                                        ), 
                                    inline: 
                                        true 
                                }, 
 
                                { 
                                    name: 
                                        "Status", 
                                    value: 
                                        auth.authorized 
                                            ? "🟢 Authorized" 
                                            : "🔴 Not Authorized", 
                                    inline: 
                                        true 
                                }, 
 
                                { 
                                    name: 
                                        "Source", 
                                    value: 
                                        auth.authorization_source || 
                                        "Unknown", 
                                    inline: 
                                        true 
                                } 
                            ) 
                            .setColor( 
                                auth.authorized 
                                    ? getColor( 
                                        "green" 
                                    ) 
                                    : getColor( 
                                        "red" 
                                    ) 
                            ) 
                    ] 
                }); 
            } 
 
            /* ================================================ 
               PROFILE 
            ================================================ */ 
 
            if ( 
                interaction.commandName === 
                "profile" 
            ) { 
 
                const config = 
                    await getTicketConfig( 
                        guild.id 
                    ); 
 
                if ( 
                    !isFinancialOperations( 
                        interaction.member 
                    ) && 
                    !isSupport( 
                        interaction.member 
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
                                "You do not have permission to use this command." 
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
 
                const user = 
                    await getRobloxUser( 
                        username 
                    ); 
 
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
 
                const profile = 
                    await getRobloxProfile( 
                        user.id 
                    ); 
 
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
 
                const avatar = 
                    await getRobloxAvatar( 
                        user.id 
                    ); 
 
                const social = 
                    await getRobloxFollowers( 
                        user.id 
                    ); 
 
                const embed = 
                    new EmbedBuilder() 
                        .setTitle( 
                            `👤 ${profile.name}` 
                        ) 
                        .setDescription( 
                            profile.description || 
                            "This user has no profile description." 
                        ) 
                        .addFields( 
 
                            { 
                                name: 
                                    "Username", 
                                value: 
                                    profile.name, 
                                inline: 
                                    true 
                            }, 
 
                            { 
                                name: 
                                    "Display Name", 
                                value: 
                                    profile.displayName, 
                                inline: 
                                    true 
                            }, 
 
                            { 
                                name: 
                                    "Roblox ID", 
                                value: 
                                    String( 
                                        profile.id 
                                    ), 
                                inline: 
                                    true 
                            }, 
 
                            { 
                                name: 
                                    "Followers", 
                                value: 
                                    String( 
                                        social.followers 
                                    ), 
                                inline: 
                                    true 
                            }, 
 
                            { 
                                name: 
                                    "Following", 
                                value: 
                                    String( 
                                        social.following 
                                    ), 
                                inline: 
                                    true 
                            }, 
 
                            { 
                                name: 
                                    "Created", 
                                value: 
                                    `<t:${Math.floor( 
                                        new Date( 
                                            profile.created 
                                        ).getTime() / 
                                        1000 
                                    )}:D>`, 
                                inline: 
                                    true 
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
 
            /* ================================================ 
               HISTORY 
            ================================================ */ 
 
            if ( 
                interaction.commandName === 
                "history" 
            ) { 
 
                const config = 
                    await getTicketConfig( 
                        guild.id 
                    ); 
 
                if ( 
                    !isFinancialOperations( 
                        interaction.member 
                    ) && 
                    !isSupport( 
                        interaction.member 
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
                                "You do not have permission to use this command." 
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
 
                const user = 
                    await getRobloxUser( 
                        username 
                    ); 
 
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
 
                    return interaction.reply({ 
                        embeds: [ 
                            new EmbedBuilder() 
                                .setTitle( 
                                    "📜 Authorization History" 
                                ) 
                                .setDescription( 
                                    `No authorization history exists for **${user.name}**.` 
                                ) 
                                .setColor( 
                                    getColor( 
                                        "dark" 
                                    ) 
                                ) 
                        ] 
                    }); 
                } 
 
                const description = 
                    result.rows 
                        .map(row => { 
 
                            const timestamp = 
                                Math.floor( 
                                    new Date( 
                                        row.created_at 
                                    ).getTime() / 
                                    1000 
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
                            .setTitle( 
                                `📜 History — ${user.name}` 
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
 
            /* ================================================ 
               STATS 
            ================================================ */ 
 
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
 
                const open = 
                    await query( 
                        ` 
                        SELECT COUNT(*) AS count 
                        FROM tickets 
                        WHERE guild_id = $1 
                        AND status != 'closed' 
                        `, 
                        [guild.id] 
                    ); 
 
                const closed = 
                    await query( 
                        ` 
                        SELECT COUNT(*) AS count 
                        FROM tickets 
                        WHERE guild_id = $1 
                        AND status = 'closed' 
                        `, 
                        [guild.id] 
                    ); 
 
                const claims = 
                    await query( 
                        ` 
                        SELECT COALESCE( 
                            SUM(count), 
                            0 
                        ) AS count 
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
                                        "Open Tickets", 
                                    value: 
                                        String( 
                                            open.rows[0].count 
                                        ), 
                                    inline: 
                                        true 
                                }, 
 
                                { 
                                    name: 
                                        "Closed Tickets", 
                                    value: 
                                        String( 
                                            closed.rows[0].count 
                                        ), 
                                    inline: 
                                        true 
                                }, 
 
                                { 
                                    name: 
                                        "Total Claims", 
                                    value: 
                                        String( 
                                            claims.rows[0].count 
                                        ), 
                                    inline: 
                                        true 
                                } 
                            ) 
                            .setColor( 
                                getColor("blue") 
                            ) 
                            .setTimestamp() 
                    ] 
                }); 
            } 
 
            /* ================================================ 
               WIPE TICKETS 
            ================================================ */ 
 
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
                                "You need DeadSignal Operations." 
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
 
                await updateLeaderboard( 
                    guild 
                ); 
 
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
                                "You need Support or Management to escalate tickets." 
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
                                "This command must be used inside a ticket." 
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
               TICKET COMMAND 
            ================================================ */ 
 
            if ( 
                interaction.commandName === 
                "ticket" 
            ) { 
 
                const subcommand = 
                    interaction.options 
                        .getSubcommand(); 
 
                /* SETUP */ 
 
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
                                    "You need DeadSignal Operations to setup tickets." 
                                ) 
                            ], 
                            ephemeral: true 
                        }); 
                    } 
 
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

                    const panelChannel =
                        interaction.options
                            .getChannel("panel_channel", true); 
 
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
                            SUPPORT_ROLE_ID, 
                            managementRole.id, 
                            category.id, 
                            logChannel.id, 
                            panelChannel.id, 
                            panelColor, 
                            ticketColor, 
                            successColor, 
                            errorColor, 
                            leaderboardColor 
                        ] 
                    ); 
 
                    const panel = 
                        new EmbedBuilder() 
                            .setTitle( 
                                "🎫 Devil Support" 
                            ) 
                            .setDescription( 
                                "Need help? Open a ticket below and our support team will assist you.\n\n" + 
                                "Please provide as much information as possible when opening your ticket." 
                            ) 
                            .addFields({ 
                                name: 
                                    "Support", 
                                value: 
                                    `<@&${SUPPORT_ROLE_ID}>`, 
                                inline: 
                                    true 
                            }) 
                            .setColor( 
                                getColor( 
                                    panelColor 
                                ) 
                            ) 
                            .setFooter({ 
                                text: 
                                    "Devil Support System" 
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
                                    .setEmoji( 
                                        "🎫" 
                                    ) 
                                    .setStyle( 
                                        ButtonStyle.Primary 
                                    ) 
                            ); 
 
                    const message = 
                        await panelChannel 
                            .send({ 
                                embeds: [ 
                                    panel 
                                ], 
                                components: [ 
                                    buttons 
                                ] 
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
 
                    await updateLeaderboard( 
                        guild 
                    ); 
 
                    return; 
                } 
 
                /* PANEL */ 
 
                if ( 
                    subcommand === 
                    "panel" 
                ) { 
 
                    const config = 
                        await getTicketConfig( 
                            guild.id 
                        ); 
 
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
                            interaction.member 
                        ) 
                    ) { 
 
                        return interaction.reply({ 
                            embeds: [ 
                                errorEmbed( 
                                    "No Permission", 
                                    "You need DeadSignal Operations or Support." 
                                ) 
                            ], 
                            ephemeral: true 
                        }); 
                    } 
 
                    const panel = 
                        new EmbedBuilder() 
                            .setTitle( 
                                "🎫 Devil Support" 
                            ) 
                            .setDescription( 
                                "Need help? Open a ticket below and our support team will assist you." 
                            ) 
                            .addFields({ 
                                name: 
                                    "Support", 
                                value: 
                                    `<@&${SUPPORT_ROLE_ID}>`, 
                                inline: 
                                    true 
                            }) 
                            .setColor( 
                                getColor( 
                                    config.panel_color 
                                ) 
                            ) 
                            .setFooter({ 
                                text: 
                                    "Devil Support System" 
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
                                    .setEmoji( 
                                        "🎫" 
                                    ) 
                                    .setStyle( 
                                        ButtonStyle.Primary 
                                    ) 
                            ); 
 
                    const panelChannel = guild.channels.cache.get(config.panel_channel_id)
                        || await guild.channels.fetch(config.panel_channel_id).catch(() => null);

                    if (!panelChannel || panelChannel.type !== ChannelType.GuildText) {
                        return interaction.reply({
                            embeds: [errorEmbed("Panel Channel Missing", "The configured panel channel no longer exists. Run `/ticket setup` again.")],
                            ephemeral: true
                        });
                    }

                    const message = 
                        await panelChannel 
                            .send({ 
                                embeds: [ 
                                    panel 
                                ], 
                                components: [ 
                                    buttons 
                                ] 
                            }); 
 
                    await query( 
                        ` 
                        UPDATE ticket_config 
                        SET panel_channel_id = $1, 
                            panel_message_id = $2 
                        WHERE guild_id = $3 
                        `, 
                        [ 
                            panelChannel.id, 
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
                                "This command must be used inside a ticket." 
                            ) 
                        ], 
                        ephemeral: true 
                    }); 
                } 
 
                const config = 
                    await getTicketConfig( 
                        guild.id 
                    ); 
 
                /* CLAIM */ 
 
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
                                    "You need Support or Management to claim tickets." 
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
 
                    await updateLeaderboard( 
                        guild 
                    ); 
 
                    return; 
                } 
 
                /* UNCLAIM */ 
 
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
                                    "You need Support or Management to unclaim tickets." 
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
                                    "This ticket is not claimed." 
                                ) 
                            ], 
                            ephemeral: true 
                        }); 
                    } 
 
                    await query( 
                        ` 
                        UPDATE tickets 
                        SET claimer_id = NULL, 
                            claimed_at = NULL, 
                            status = 'open' 
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
                                "This ticket is now available for another staff member to claim.", 
                                config.success_color 
                            ) 
                        ] 
                    }); 
 
                    return; 
                } 
 
                /* RENAME */ 
 
                if ( 
                    subcommand === 
                    "rename" 
                ) { 
 
                    if ( 
                        !isSupport( 
                            interaction.member 
                        ) 
                    ) { 
 
                        return interaction.reply({ 
                            embeds: [ 
                                errorEmbed( 
                                    "No Permission", 
                                    "You need Support to rename tickets." 
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
                            ); 
 
                    await interaction.channel 
                        .setName(name) 
                        .catch(() => {}); 
 
                    return interaction.reply({ 
                        embeds: [ 
                            successEmbed( 
                                "Ticket Renamed", 
                                `The ticket has been renamed to **${name}**.` 
                            ) 
                        ] 
                    }); 
                } 
 
                /* ADD USER */ 
 
                if ( 
                    subcommand === 
                    "add" 
                ) { 
 
                    if ( 
                        !isSupport( 
                            interaction.member 
                        ) 
                    ) { 
 
                        return interaction.reply({ 
                            embeds: [ 
                                errorEmbed( 
                                    "No Permission", 
                                    "You need Support to add users." 
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
                                AttachFiles: true, 
                                EmbedLinks: true, 
                                AddReactions: true 
                            } 
                        ) 
                        .catch(() => {}); 
 
                    return interaction.reply({ 
                        embeds: [ 
                            successEmbed( 
                                "User Added", 
                                `${user} has been added to the ticket.` 
                            ) 
                        ] 
                    }); 
                } 
 
                /* REMOVE USER */ 
 
                if ( 
                    subcommand === 
                    "remove" 
                ) { 
 
                    if ( 
                        !isSupport( 
                            interaction.member 
                        ) 
                    ) { 
 
                        return interaction.reply({ 
                            embeds: [ 
                                errorEmbed( 
                                    "No Permission", 
                                    "You need Support to remove users." 
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
                        .delete( 
                            user.id 
                        ) 
                        .catch(() => {}); 
 
                    return interaction.reply({ 
                        embeds: [ 
                            successEmbed( 
                                "User Removed", 
                                `${user} has been removed from the ticket.` 
                            ) 
                        ] 
                    }); 
                } 
 
                /* FORCE CLOSE */ 
 
                if ( 
                    subcommand === 
                    "forceclose" 
                ) { 
 
                    if ( 
                        !isManagement( 
                            interaction.member, 
                            config 
                        ) 
                    ) { 
 
                        return interaction.reply({ 
                            embeds: [ 
                                errorEmbed( 
                                    "No Permission", 
                                    "You need Management to force close tickets." 
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
                        [ 
                            interaction.channel.id 
                        ] 
                    ); 
 
                    await interaction.reply({ 
                        embeds: [ 
                            successEmbed( 
                                "Ticket Force Closed", 
                                "This ticket will be deleted shortly.", 
                                config.success_color 
                            ) 
                        ] 
                    }); 
 
                    await logTicket( 
                        guild, 
                        config, 
                        "Ticket Force Closed", 
                        `${interaction.user} force closed ${interaction.channel}.`, 
                        config.success_color 
                    ); 
 
                    setTimeout( 
                        async () => { 
                            await interaction.channel 
                                .delete() 
                                .catch(() => {}); 
                        }, 
                        3000 
                    ); 
 
                    return; 
                } 
 
                /* TRANSFER */ 
 
                if ( 
                    subcommand === 
                    "transfer" 
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
                                    "You need Support or Management to transfer tickets." 
                                ) 
                            ], 
                            ephemeral: true 
                        }); 
                    } 
 
                    const target = 
                        interaction.options 
                            .getUser( 
                                "user", 
                                true 
                            ); 
 
                    if ( 
                        target.bot 
                    ) { 
 
                        return interaction.reply({ 
                            embeds: [ 
                                errorEmbed( 
                                    "Invalid User", 
                                    "You cannot transfer a ticket to a bot." 
                                ) 
                            ], 
                            ephemeral: true 
                        }); 
                    } 
 
                    await query( 
                        ` 
                        CREATE TABLE IF NOT EXISTS ticket_transfer_requests ( 
                            id SERIAL PRIMARY KEY, 
                            channel_id TEXT NOT NULL, 
                            guild_id TEXT NOT NULL, 
                            requester_id TEXT NOT NULL, 
                            target_user_id TEXT NOT NULL, 
                            status TEXT NOT NULL DEFAULT 'pending', 
                            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() 
                        ) 
                        ` 
                    ); 
 
                    const existing = 
                        await query( 
                            ` 
                            SELECT * 
                            FROM ticket_transfer_requests 
                            WHERE channel_id = $1 
                            AND status = 'pending' 
                            LIMIT 1 
                            `, 
                            [ 
                                interaction.channel.id 
                            ] 
                        ); 
 
                    if ( 
                        existing.rows.length 
                    ) { 
 
                        return interaction.reply({ 
                            embeds: [ 
                                errorEmbed( 
                                    "Transfer Pending", 
                                    "There is already a pending transfer request for this ticket." 
                                ) 
                            ], 
                            ephemeral: true 
                        }); 
                    } 
 
                    const result = 
                        await query( 
                            ` 
                            INSERT INTO ticket_transfer_requests ( 
                                channel_id, 
                                guild_id, 
                                requester_id, 
                                target_user_id, 
                                status 
                            ) 
                            VALUES ( 
                                $1,$2,$3,$4,'pending' 
                            ) 
                            RETURNING id 
                            `, 
                            [ 
                                interaction.channel.id, 
                                guild.id, 
                                interaction.user.id, 
                                target.id 
                            ] 
                        ); 
 
                    const requestId = 
                        result.rows[0].id; 
 
                    await interaction.channel.send({ 
                        content: 
                            `<@${target.id}>`, 
                        embeds: [ 
                            new EmbedBuilder() 
                                .setTitle( 
                                    "🔄 Ticket Transfer Request" 
                                ) 
                                .setDescription( 
                                    `${interaction.user} has requested to transfer this ticket to ${target}.\n\n` + 
                                    `Only **${target}** can accept or deny this request.` 
                                ) 
                                .setColor( 
                                    getColor( 
                                        "purple" 
                                    ) 
                                ) 
                                .setTimestamp() 
                        ], 
                        components: [ 
                            new ActionRowBuilder() 
                                .addComponents( 
 
                                    new ButtonBuilder() 
                                        .setCustomId( 
                                            `ticket_transfer_accept:${requestId}` 
                                        ) 
                                        .setLabel( 
                                            "Accept Transfer" 
                                        ) 
                                        .setEmoji( 
                                            "✅" 
                                        ) 
                                        .setStyle( 
                                            ButtonStyle.Success 
                                        ), 
 
                                    new ButtonBuilder() 
                                        .setCustomId( 
                                            `ticket_transfer_deny:${requestId}` 
                                        ) 
                                        .setLabel( 
                                            "Deny Transfer" 
                                        ) 
                                        .setEmoji( 
                                            "❌" 
                                        ) 
                                        .setStyle( 
                                            ButtonStyle.Danger 
                                        ) 
                                ) 
                        ] 
                    }); 
 
                    return interaction.reply({ 
                        embeds: [ 
                            successEmbed( 
                                "Transfer Requested", 
                                `${target} has received a transfer request.` 
                            ) 
                        ], 
                        ephemeral: true 
                    }); 
                } 
            } 
 
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
                        content: 
                            "An unexpected error occurred.", 
                        ephemeral: true 
                    }) 
                    .catch(() => {}); 
            } else { 
                await interaction 
                    .reply({ 
                        content: 
                            "An unexpected error occurred.", 
                        ephemeral: true 
                    }) 
                    .catch(() => {}); 
            } 
        } 
    } 
); 
 
/* ========================================================= 
   BUTTON HANDLER CONTINUED IN PART 2 
========================================================= */ 
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
 
commands.push( 
 
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
                .addStringOption(option => colorOption(option, "panel_color", "Panel colour", "blue"))
                .addStringOption(option => colorOption(option, "ticket_color", "Ticket colour", "blue"))
                .addStringOption(option => colorOption(option, "success_color", "Success colour", "green"))
                .addStringOption(option => colorOption(option, "error_color", "Error colour", "red"))
                .addStringOption(option => colorOption(option, "leaderboard_color", "Leaderboard colour", "purple"))
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
); 
 
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
        .setColor(getColor(config?.panel_color || "blue")) 
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
/* ============================================================
   TICKET DATABASE HELPERS
============================================================ */

async function getCurrentTicket(channelId) {
    const result = await query(
        `SELECT * FROM tickets WHERE channel_id = $1 LIMIT 1`,
        [channelId]
    );
    return result.rows[0] || null;
}

async function cleanupStaleTickets(guild) {
    if (!guild) return { removed: 0 };

    const result = await query(`
        SELECT channel_id, opener_id
        FROM tickets
        WHERE guild_id = $1
          AND status NOT IN ('closed', 'resolved')
    `, [guild.id]);

    let removed = 0;

    for (const row of result.rows) {
        let channel = null;

        try {
            channel = await guild.channels.fetch(String(row.channel_id));
        } catch (_) {
            channel = null;
        }

        if (channel) continue;

        // The Discord channel is gone, so this is a stale database ticket.
        await query(`
            DELETE FROM ticket_join_requests
            WHERE channel_id = $1
        `, [row.channel_id]).catch(() => {});

        await query(`
            DELETE FROM tickets
            WHERE channel_id = $1
        `, [row.channel_id]).catch(() => {});

        removed++;
    }

    if (removed) {
        console.log(`[TICKETS] Cleaned ${removed} stale ticket record(s) in ${guild.name}`);
    }

    return { removed };
}

async function cleanupAllStaleTickets() {
    for (const guild of client.guilds.cache.values()) {
        await cleanupStaleTickets(guild).catch(error => {
            console.error(`[TICKETS] Cleanup failed in ${guild.name}:`, error.message);
        });
    }
}

async function createTicket(guild, user) {
    const config = await getTicketConfig(guild.id);
    if (!config) {
        throw new Error("Ticket system is not configured. Run /ticket setup first.");
    }

    const lockClient = await pool.connect();
    let channel = null;

    try {
        await lockClient.query("BEGIN");

        // One ticket per user, even if they spam the button at the same time.
        await lockClient.query(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            [`deadsignal-ticket:${guild.id}:${user.id}`]
        );

        const existing = await lockClient.query(`
            SELECT *
            FROM tickets
            WHERE guild_id = $1
              AND opener_id = $2
              AND status NOT IN ('closed', 'resolved')
            ORDER BY created_at DESC
        `, [guild.id, user.id]);

        // Check every existing record. If Discord cannot find the channel,
        // remove the stale database record automatically.
        for (const row of existing.rows) {
            let existingChannel = null;
            try {
                existingChannel = await guild.channels.fetch(String(row.channel_id));
            } catch (_) {
                existingChannel = null;
            }

            if (existingChannel) {
                await lockClient.query("COMMIT");
                return { existing: true, channelId: existingChannel.id };
            }

            await lockClient.query(
                `DELETE FROM ticket_join_requests WHERE channel_id = $1`,
                [row.channel_id]
            ).catch(() => {});

            await lockClient.query(
                `DELETE FROM tickets WHERE channel_id = $1`,
                [row.channel_id]
            );
        }

        const category = guild.channels.cache.get(TICKET_CATEGORY_ID) ||
            await guild.channels.fetch(TICKET_CATEGORY_ID).catch(() => null);

        if (!category || category.type !== ChannelType.GuildCategory) {
            throw new Error("The configured ticket category does not exist or is not a category.");
        }

        const supportRole = guild.roles.cache.get(String(config.support_role_id)) ||
            await guild.roles.fetch(String(config.support_role_id)).catch(() => null);
        const managementRole = guild.roles.cache.get(String(config.management_role_id)) ||
            await guild.roles.fetch(String(config.management_role_id)).catch(() => null);

        if (!supportRole) throw new Error("The configured Support role no longer exists.");
        if (!managementRole) throw new Error("The configured Management role no longer exists.");

        const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
        if (!me) throw new Error("I could not access my server member.");
        if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
            throw new Error("I need the Manage Channels permission to create tickets.");
        }

        const baseName = String(user.username || user.id)
            .toLowerCase()
            .replace(/[^a-z0-9-_]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 70) || "user";

        channel = await guild.channels.create({
            name: `ticket-${baseName}`.slice(0, 100),
            type: ChannelType.GuildText,
            parent: category.id,
            topic: `DeadSignal ticket for ${user.tag} (${user.id})`,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                },
                {
                    id: supportRole.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                },
                {
                    id: managementRole.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                },
                {
                    id: CLAIM_ROLE_ID,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                },
                {
                    id: me.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.ManageMessages,
                        PermissionFlagsBits.EmbedLinks,
                        PermissionFlagsBits.AttachFiles
                    ]
                }
            ]
        });

        const inserted = await lockClient.query(`
            INSERT INTO tickets (
                channel_id,
                guild_id,
                opener_id,
                opener_tag,
                status
            )
            VALUES ($1, $2, $3, $4, 'open')
            RETURNING *
        `, [channel.id, guild.id, user.id, user.tag]);

        const ticket = inserted.rows[0];
        if (!ticket) throw new Error("The ticket channel was created but the database record could not be created.");

        await lockClient.query("COMMIT");

        try {
            await channel.send({
                content: `<@${user.id}> <@&${CLAIM_ROLE_ID}>`,
                embeds: [ticketEmbed(config, ticket, user)],
                components: [ticketButtons()]
            });

            await logTicket(
                guild,
                config,
                "🎫 Ticket Created",
                `${user} created ${channel}.`,
                config.ticket_color || "blue"
            ).catch(error => console.error("[TICKET LOG ERROR]", error));

            await updateLeaderboard(guild).catch(() => {});
        } catch (sendError) {
            // Keep the DB consistent if Discord refuses the first ticket message.
            await query(`DELETE FROM tickets WHERE channel_id = $1`, [channel.id]).catch(() => {});
            await channel.delete("Ticket setup message failed").catch(() => {});
            throw sendError;
        }

        return { existing: false, channelId: channel.id };
    } catch (error) {
        await lockClient.query("ROLLBACK").catch(() => {});
        if (channel) {
            await channel.delete("Ticket creation failed").catch(() => {});
        }
        console.error("[TICKET CREATE ERROR]", error);
        throw error;
    } finally {
        lockClient.release();
    }
}

async function refreshTicketMessage(channel) {
    const ticket = await getCurrentTicket(channel.id);
    if (!ticket) return;
    const config = await getTicketConfig(ticket.guild_id);
    if (!config) return;
    const opener = await client.users.fetch(ticket.opener_id).catch(() => null);
    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return;
    const botMessage = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title === "🎫 Support Ticket");
    if (!botMessage) return;
    await botMessage.edit({
        embeds: [ticketEmbed(config, ticket, opener)],
        components: [ticket.claimer_id ? ticketClaimedButtons() : ticketButtons()]
    }).catch(() => {});
}

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

                let result;
                try {
                    result = await createTicket(
                        interaction.guild,
                        interaction.user
                    );
                } catch (error) {
                    console.error("[CREATE TICKET BUTTON ERROR]", error);
                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                "Ticket Creation Failed",
                                `\`${String(error?.message || "Unknown error").slice(0, 900)}\``
                            )
                        ]
                    });
                } 
 
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
                (interaction.customId === "ticket_join" || interaction.customId === "ticket_join_request") 
            ) { 
 
                if (!isClaimStaff(member) && !isManagement(member)) { 
 
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

        if (interaction.commandName === "cmdshelp") {
            return interaction.reply({
                embeds: [new EmbedBuilder().setColor(COLORS.blue).setTitle("📚 DeadSignal Bot Commands").setDescription("**Authorization**\n`/auth <robloxuser>` • `/check <robloxuser>` • `/profile <robloxuser>` • `/history <robloxuser>`\n\n**Tickets**\n`/ticket setup` • `/ticket panel` • `/ticket claim` • `/ticket unclaim` • `/ticket transfer` • `/ticket rename` • `/ticket add` • `/ticket remove` • `/ticket close` • `/ticket forceclose`\n\n**Other**\n`/escalate` • `/stats` • `/wipetickets`\n\n**Claim rule:** one staff member can claim a ticket. Other staff use **Request to Join** and wait for approval.").setFooter({text:"DeadSignal"}).setTimestamp()],
                ephemeral: true
            });
        } 
 
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
                        content: `❌ This ticket is already claimed by <@${ticket.claimer_id}>. Use **Request to Join** instead.`,
                        ephemeral: true
                    });
                }

                const claimResult = await db(`
                    UPDATE tickets
                    SET claimer_id = $1, status = 'claimed', claimed_at = NOW()
                    WHERE channel_id = $2 AND status <> 'closed' AND claimer_id IS NULL
                    RETURNING channel_id
                `, [interaction.user.id, interaction.channel.id]);

                if (!claimResult.rows.length) {
                    const latest = await requireTicket(interaction);
                    return interaction.reply({
                        content: latest?.claimer_id ? `❌ This ticket was just claimed by <@${latest.claimer_id}>. Use **Request to Join** instead.` : '❌ This ticket could not be claimed. Try again.',
                        ephemeral: true
                    });
                }

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
 
        const safeError = String(error?.message || "Unknown error").slice(0, 900);
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
                content: `❌ Something went wrong: \`${safeError}\``
            }).catch(() => {});
        } else if (interaction.isRepliable()) {
            await interaction.reply({
                content: `❌ Something went wrong: \`${safeError}\``,
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
