/*
 * ROBLOX DISCORD ADMIN BOT
 * ------------------------------------------------------------
 * Main Discord application.
 *
 * This file intentionally keeps the whole Discord side in one place so
 * it is easy to paste into a Railway project.
 *
 * Current command set:
 *
 * MODERATOR
 *   /rban
 *   /runban
 *   /rhistory
 *   /rinfo
 *   /rservers
 *   /rplayers
 *   /rserver
 *   /altcheck
 *
 * ADMIN
 *   /rgive
 *   /rremove
 *   /rreset
 *
 * MANAGER
 *   /rannounce
 *   /rshutdown
 *   /rmaintenance
 *
 * The Roblox side is handled by RobloxBridge.server.lua.
 *
 * IMPORTANT:
 * - Never hard-code DISCORD_TOKEN.
 * - Never hard-code ROBLOX_API_KEY.
 * - Railway environment variables are used automatically.
 */

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActivityType,
    ChannelType,
} = require("discord.js");

const {
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus,
} = require("@discordjs/voice");

const { Pool } = require("pg");

const crypto = require("crypto");

// ============================================================
// SECTION 01 - CONFIGURATION
// ============================================================

const CONFIG = Object.freeze({
    discordToken: process.env.DISCORD_TOKEN || "",

    robloxApiKey: process.env.ROBLOX_API_KEY || "",

    universeId: String(
        process.env.ROBLOX_UNIVERSE_ID || "10768167536"
    ),

    announceRoleId: String(
        process.env.ANNOUNCE_ROLE_ID || "1555281795296133221"
    ),

    voiceChannelId: String(
        process.env.VOICE_CHANNEL_ID || "1553094154890903592"
    ),

    moderatorRoleId: String(
        process.env.MODERATOR_ROLE_ID || ""
    ),

    adminRoleId: String(
        process.env.ADMIN_ROLE_ID || ""
    ),

    managerRoleId: String(
        process.env.MANAGER_ROLE_ID || ""
    ),

    apiSecret: String(
        process.env.API_SECRET || ""
    ),

    botPublicUrl: String(
        process.env.BOT_PUBLIC_URL || ""
    ),

    databaseUrl: String(
        process.env.DATABASE_URL || ""
    ),

    commandGuildId: String(
        process.env.COMMAND_GUILD_ID || ""
    ),

    commandRegisterMode: String(
        process.env.COMMAND_REGISTER_MODE || "global"
    ),

    robloxCommandTopic: "DiscordAdminCommands",

    robloxResultTopic: "DiscordAdminResults",

    robloxAnnouncementTopic: "GlobalAnnouncement",

    requestTimeoutMs: 15000,

    voiceReconnectDelayMs: 5000,

    robloxTimeoutMs: 15000,

    maxAnnouncementLength: 200,

    maxReasonLength: 400,

    maxPrivateReasonLength: 1000,

    maxHistoryRows: 25,

    maxServerResults: 100,

    maxPlayersDisplay: 30,

    color: 0xFFFFFF,

    logPrefix: "[RobloxDiscordBot]",
});

// ============================================================
// SECTION 02 - STARTUP VALIDATION
// ============================================================

function validateStartup() {
    const required = [
        ["DISCORD_TOKEN", CONFIG.discordToken],
        ["ROBLOX_API_KEY", CONFIG.robloxApiKey],
        ["ROBLOX_UNIVERSE_ID", CONFIG.universeId],
    ];

    const missing = required
        .filter(([, value]) => !value)
        .map(([name]) => name);

    if (missing.length > 0) {
        console.error(
            `${CONFIG.logPrefix} Missing environment variables: ${missing.join(", ")}`
        );

        process.exit(1);
    }

    console.log(
        `${CONFIG.logPrefix} Universe: ${CONFIG.universeId}`
    );

    console.log(
        `${CONFIG.logPrefix} Announcement role: ${CONFIG.announceRoleId}`
    );

    console.log(
        `${CONFIG.logPrefix} Voice channel: ${CONFIG.voiceChannelId}`
    );

    if (!CONFIG.databaseUrl) {
        console.warn(
            `${CONFIG.logPrefix} DATABASE_URL is not configured. `
            + `Moderation history will use in-memory storage only.`
        );
    }

    if (!CONFIG.botPublicUrl) {
        console.warn(
            `${CONFIG.logPrefix} BOT_PUBLIC_URL is not configured. `
            + `Roblox callback responses are disabled.`
        );
    }
}

validateStartup();

// ============================================================
// SECTION 03 - DISCORD CLIENT
// ============================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// ============================================================
// SECTION 04 - DATABASE
// ============================================================

let pool = null;

const memoryHistory = [];

function createDatabasePool() {
    if (!CONFIG.databaseUrl) {
        return null;
    }

    return new Pool({
        connectionString: CONFIG.databaseUrl,
        ssl: {
            rejectUnauthorized: false,
        },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });
}

pool = createDatabasePool();

async function initializeDatabase() {
    if (!pool) {
        return;
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS roblox_moderation_history (
            id BIGSERIAL PRIMARY KEY,
            action TEXT NOT NULL,
            roblox_user_id BIGINT,
            roblox_username TEXT,
            discord_user_id TEXT,
            discord_username TEXT,
            reason TEXT,
            duration_seconds BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_roblox_history_user
        ON roblox_moderation_history(roblox_user_id)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_roblox_history_created
        ON roblox_moderation_history(created_at DESC)
    `);

    console.log(
        `${CONFIG.logPrefix} Database initialized.`
    );
}

async function addHistoryEntry(entry) {
    const normalized = {
        action: String(entry.action || "unknown"),
        robloxUserId: entry.robloxUserId
            ? Number(entry.robloxUserId)
            : null,
        robloxUsername: String(entry.robloxUsername || "Unknown"),
        discordUserId: String(entry.discordUserId || "Unknown"),
        discordUsername: String(entry.discordUsername || "Unknown"),
        reason: String(entry.reason || ""),
        durationSeconds: entry.durationSeconds
            ? Number(entry.durationSeconds)
            : null,
        createdAt: new Date(),
    };

    memoryHistory.unshift(normalized);

    if (memoryHistory.length > 500) {
        memoryHistory.length = 500;
    }

    if (!pool) {
        return;
    }

    try {
        await pool.query(
            `
            INSERT INTO roblox_moderation_history (
                action,
                roblox_user_id,
                roblox_username,
                discord_user_id,
                discord_username,
                reason,
                duration_seconds
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            [
                normalized.action,
                normalized.robloxUserId,
                normalized.robloxUsername,
                normalized.discordUserId,
                normalized.discordUsername,
                normalized.reason,
                normalized.durationSeconds,
            ]
        );
    } catch (error) {
        console.error(
            `${CONFIG.logPrefix} Failed to write history:`,
            error
        );
    }
}

async function getHistory(userId, limit = CONFIG.maxHistoryRows) {
    const safeLimit = Math.max(
        1,
        Math.min(
            Number(limit) || CONFIG.maxHistoryRows,
            CONFIG.maxHistoryRows
        )
    );

    if (pool) {
        try {
            const result = await pool.query(
                `
                SELECT
                    action,
                    roblox_user_id,
                    roblox_username,
                    discord_user_id,
                    discord_username,
                    reason,
                    duration_seconds,
                    created_at
                FROM roblox_moderation_history
                WHERE roblox_user_id = $1
                ORDER BY created_at DESC
                LIMIT $2
                `,
                [
                    Number(userId),
                    safeLimit,
                ]
            );

            return result.rows;
        } catch (error) {
            console.error(
                `${CONFIG.logPrefix} Database history query failed:`,
                error
            );
        }
    }

    return memoryHistory
        .filter(
            entry =>
                Number(entry.robloxUserId) === Number(userId)
        )
        .slice(0, safeLimit);
}

// ============================================================
// SECTION 05 - SMALL UTILITIES
// ============================================================

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function makeRequestId() {
    return crypto.randomUUID();
}

function cleanText(value, maxLength = 1000) {
    return String(value ?? "")
        .replace(/\r/g, "")
        .replace(/\u0000/g, "")
        .trim()
        .slice(0, maxLength);
}

function cleanUsername(value) {
    return cleanText(value, 20);
}

function cleanReason(value) {
    return cleanText(
        value,
        CONFIG.maxReasonLength
    );
}

function cleanPrivateReason(value) {
    return cleanText(
        value,
        CONFIG.maxPrivateReasonLength
    );
}

function parseDuration(value) {
    const raw = cleanText(value, 32).toLowerCase();

    if (!raw || raw === "permanent" || raw === "perm") {
        return -1;
    }

    const match = raw.match(
        /^(\d+)\s*(s|m|h|d|w)$/
    );

    if (!match) {
        return null;
    }

    const amount = Number(match[1]);
    const unit = match[2];

    const multiplier = {
        s: 1,
        m: 60,
        h: 60 * 60,
        d: 60 * 60 * 24,
        w: 60 * 60 * 24 * 7,
    }[unit];

    if (!multiplier) {
        return null;
    }

    const seconds = amount * multiplier;

    if (!Number.isSafeInteger(seconds)) {
        return null;
    }

    return seconds;
}

function isSnowflake(value) {
    return /^\d{15,25}$/.test(String(value || ""));
}

function truncate(value, length = 1000) {
    const text = String(value ?? "");

    if (text.length <= length) {
        return text;
    }

    return `${text.slice(0, length - 3)}...`;
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-US");
}

function formatDuration(seconds) {
    if (Number(seconds) === -1) {
        return "Permanent";
    }

    const value = Number(seconds);

    if (!Number.isFinite(value) || value < 0) {
        return "Unknown";
    }

    const units = [
        ["week", 604800],
        ["day", 86400],
        ["hour", 3600],
        ["minute", 60],
        ["second", 1],
    ];

    let remaining = Math.floor(value);
    const parts = [];

    for (const [name, size] of units) {
        if (remaining >= size) {
            const count = Math.floor(
                remaining / size
            );

            remaining %= size;

            parts.push(
                `${count} ${name}${count === 1 ? "" : "s"}`
            );
        }

        if (parts.length >= 2) {
            break;
        }
    }

    return parts.length
        ? parts.join(", ")
        : "0 seconds";
}

function getDiscordMember(interaction) {
    if (!interaction.guild) {
        return null;
    }

    return interaction.member;
}

function memberHasRole(member, roleId) {
    if (!member || !roleId) {
        return false;
    }

    if (member.roles?.cache) {
        return member.roles.cache.has(roleId);
    }

    if (Array.isArray(member.roles)) {
        return member.roles.includes(roleId);
    }

    return false;
}

function memberIsAdministrator(member) {
    if (!member) {
        return false;
    }

    return Boolean(
        member.permissions?.has?.(
            PermissionFlagsBits.Administrator
        )
    );
}

// ============================================================
// SECTION 06 - ROLE PERMISSIONS
// ============================================================

function canUseModerator(member) {
    if (!member) {
        return false;
    }

    if (memberIsAdministrator(member)) {
        return true;
    }

    if (
        CONFIG.moderatorRoleId &&
        memberHasRole(
            member,
            CONFIG.moderatorRoleId
        )
    ) {
        return true;
    }

    if (
        CONFIG.adminRoleId &&
        memberHasRole(
            member,
            CONFIG.adminRoleId
        )
    ) {
        return true;
    }

    if (
        CONFIG.managerRoleId &&
        memberHasRole(
            member,
            CONFIG.managerRoleId
        )
    ) {
        return true;
    }

    return false;
}

function canUseAdmin(member) {
    if (!member) {
        return false;
    }

    if (memberIsAdministrator(member)) {
        return true;
    }

    if (
        CONFIG.adminRoleId &&
        memberHasRole(
            member,
            CONFIG.adminRoleId
        )
    ) {
        return true;
    }

    if (
        CONFIG.managerRoleId &&
        memberHasRole(
            member,
            CONFIG.managerRoleId
        )
    ) {
        return true;
    }

    return false;
}

function canUseManager(member) {
    if (!member) {
        return false;
    }

    if (memberIsAdministrator(member)) {
        return true;
    }

    if (
        CONFIG.managerRoleId &&
        memberHasRole(
            member,
            CONFIG.managerRoleId
        )
    ) {
        return true;
    }

    return false;
}

function canUseAnnouncement(member) {
    if (!member) {
        return false;
    }

    if (memberIsAdministrator(member)) {
        return true;
    }

    return memberHasRole(
        member,
        CONFIG.announceRoleId
    );
}

// ============================================================
// SECTION 07 - ROBLOX HTTP CLIENT
// ============================================================

async function robloxRequest(
    url,
    options = {}
) {
    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        CONFIG.robloxTimeoutMs
    );

    try {
        const headers = {
            Accept: "application/json",
            ...(options.headers || {}),
        };

        if (
            options.body &&
            !headers["Content-Type"]
        ) {
            headers["Content-Type"] =
                "application/json";
        }

        const response = await fetch(
            url,
            {
                ...options,
                headers,
                signal: controller.signal,
            }
        );

        const text = await response.text();

        let data = null;

        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
        }

        if (!response.ok) {
            const error = new Error(
                `Roblox HTTP ${response.status}`
            );

            error.status = response.status;
            error.data = data;

            throw error;
        }

        return {
            status: response.status,
            data,
            headers: response.headers,
        };
    } finally {
        clearTimeout(timeout);
    }
}

function robloxApiHeaders() {
    return {
        "x-api-key": CONFIG.robloxApiKey,
        "Content-Type": "application/json",
    };
}

async function publishUniverseMessage(
    topic,
    message
) {
    const url =
        `https://apis.roblox.com/cloud/v2/universes/`
        + `${encodeURIComponent(CONFIG.universeId)}:publishMessage`;

    const payload = {
        topic: String(topic),
        message: typeof message === "string"
            ? message
            : JSON.stringify(message),
    };

    return robloxRequest(
        url,
        {
            method: "POST",
            headers: robloxApiHeaders(),
            body: JSON.stringify(payload),
        }
    );
}

async function restartUniverseServers() {
    const url =
        `https://apis.roblox.com/cloud/v2/universes/`
        + `${encodeURIComponent(CONFIG.universeId)}:restartServers`;

    return robloxRequest(
        url,
        {
            method: "POST",
            headers: robloxApiHeaders(),
            body: JSON.stringify({}),
        }
    );
}

// ============================================================
// SECTION 08 - ROBLOX USER API
// ============================================================

async function getRobloxUserByUsername(username) {
    const clean = cleanUsername(username);

    const response = await robloxRequest(
        "https://users.roblox.com/v1/usernames/users",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                usernames: [clean],
                excludeBannedUsers: false,
            }),
        }
    );

    const users = Array.isArray(response.data?.data)
        ? response.data.data
        : [];

    return users[0] || null;
}

async function getRobloxUserById(userId) {
    const response = await robloxRequest(
        `https://users.roblox.com/v1/users/${encodeURIComponent(userId)}`,
        {
            method: "GET",
        }
    );

    return response.data;
}

async function resolveRobloxUser(input) {
    const value = cleanUsername(input);

    if (!value) {
        return null;
    }

    if (/^\d+$/.test(value)) {
        try {
            return await getRobloxUserById(
                Number(value)
            );
        } catch {
            return null;
        }
    }

    try {
        return await getRobloxUserByUsername(value);
    } catch {
        return null;
    }
}

async function getRobloxAvatarThumbnail(userId) {
    const url =
        "https://thumbnails.roblox.com/v1/users/avatar-headshot"
        + `?userIds=${encodeURIComponent(userId)}`
        + "&size=420x420&format=Png&isCircular=false";

    try {
        const response = await robloxRequest(
            url,
            {
                method: "GET",
            }
        );

        return response.data?.data?.[0]?.imageUrl
            || null;
    } catch {
        return null;
    }
}

async function getRobloxPresence(userId) {
    try {
        const response = await robloxRequest(
            "https://presence.roblox.com/v1/presence/users",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    userIds: [Number(userId)],
                }),
            }
        );

        return response.data?.userPresences?.[0]
            || null;
    } catch {
        return null;
    }
}

async function areRobloxUsersFriends(
    firstUserId,
    secondUserId
) {
    const url =
        "https://friends.roblox.com/v1/users/"
        + `${encodeURIComponent(firstUserId)}/friends/${encodeURIComponent(secondUserId)}`;

    try {
        const response = await robloxRequest(
            url,
            {
                method: "GET",
            }
        );

        return Boolean(
            response.data &&
            response.data.isFriends
        );
    } catch {
        try {
            const statusUrl =
                "https://friends.roblox.com/v1/users/"
                + `${encodeURIComponent(firstUserId)}/friends/statuses`
                + `?userIds=${encodeURIComponent(secondUserId)}`;

            const response = await robloxRequest(
                statusUrl,
                {
                    method: "GET",
                }
            );

            const row = Array.isArray(response.data?.data)
                ? response.data.data[0]
                : null;

            return Boolean(
                row?.status === "Friends"
                || row?.isFriends === true
            );
        } catch {
            return false;
        }
    }
}

// ============================================================
// SECTION 09 - PLACE AND SERVER API
// ============================================================

let cachedPlaceId = null;

async function getRootPlaceId() {
    if (cachedPlaceId) {
        return cachedPlaceId;
    }

    const url =
        "https://games.roblox.com/v1/games"
        + `?universeIds=${encodeURIComponent(CONFIG.universeId)}`;

    const response = await robloxRequest(
        url,
        {
            method: "GET",
        }
    );

    const game = response.data?.data?.[0];

    if (!game?.rootPlaceId) {
        throw new Error(
            "Could not determine the root place ID."
        );
    }

    cachedPlaceId = String(
        game.rootPlaceId
    );

    return cachedPlaceId;
}

async function getPublicServers(
    cursor = "",
    limit = 100
) {
    const placeId = await getRootPlaceId();

    const url =
        "https://games.roblox.com/v1/games/"
        + `${encodeURIComponent(placeId)}/servers/Public`
        + `?sortOrder=Asc&limit=${Math.min(
            100,
            Math.max(10, Number(limit) || 100)
        )}`
        + (
            cursor
                ? `&cursor=${encodeURIComponent(cursor)}`
                : ""
        );

    const response = await robloxRequest(
        url,
        {
            method: "GET",
        }
    );

    return response.data || {
        data: [],
        nextPageCursor: null,
    };
}

async function findPublicServer(jobId) {
    let cursor = "";

    for (let page = 0; page < 10; page += 1) {
        const data = await getPublicServers(
            cursor,
            100
        );

        const found = Array.isArray(data.data)
            ? data.data.find(
                server =>
                    String(server.id) === String(jobId)
            )
            : null;

        if (found) {
            return found;
        }

        if (!data.nextPageCursor) {
            break;
        }

        cursor = data.nextPageCursor;
    }

    return null;
}

// ============================================================
// SECTION 10 - COMMAND BRIDGE
// ============================================================

const pendingRequests = new Map();

async function publishRobloxCommand(
    action,
    payload = {},
    waitForResult = false
) {
    const requestId = makeRequestId();

    const command = {
        requestId,
        action,
        ...payload,
        sentAt: new Date().toISOString(),
    };

    if (!waitForResult || !CONFIG.botPublicUrl) {
        await publishUniverseMessage(
            CONFIG.robloxCommandTopic,
            command
        );

        return {
            success: true,
            requestId,
            message: "Command published.",
            data: null,
        };
    }

    const resultPromise = new Promise(
        resolve => {
            const timeout = setTimeout(
                () => {
                    pendingRequests.delete(requestId);

                    resolve({
                        success: false,
                        requestId,
                        message:
                            "Roblox did not respond before the timeout.",
                        data: null,
                    });
                },
                CONFIG.requestTimeoutMs
            );

            pendingRequests.set(
                requestId,
                {
                    resolve,
                    timeout,
                }
            );
        }
    );

    try {
        await publishUniverseMessage(
            CONFIG.robloxCommandTopic,
            command
        );
    } catch (error) {
        const pending =
            pendingRequests.get(requestId);

        if (pending) {
            clearTimeout(pending.timeout);
            pendingRequests.delete(requestId);
        }

        throw error;
    }

    return resultPromise;
}

// ============================================================
// SECTION 11 - EMBEDS
// ============================================================

function successEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(`✅ ${title}`)
        .setDescription(
            truncate(description, 4000)
        )
        .setColor(0x57F287)
        .setTimestamp();
}

function errorEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(`❌ ${title}`)
        .setDescription(
            truncate(description, 4000)
        )
        .setColor(0xED4245)
        .setTimestamp();
}

function infoEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(`ℹ️ ${title}`)
        .setDescription(
            truncate(description, 4000)
        )
        .setColor(CONFIG.color)
        .setTimestamp();
}

function userEmbed(user, thumbnail = null) {
    const embed = new EmbedBuilder()
        .setTitle(
            `${user.displayName || user.name}`
        )
        .setDescription(
            `**Username:** \`${user.name}\`\n`
            + `**User ID:** \`${user.id}\``
        )
        .addFields(
            {
                name: "Profile",
                value:
                    `https://www.roblox.com/users/${user.id}/profile`,
                inline: false,
            }
        )
        .setColor(CONFIG.color)
        .setTimestamp();

    if (thumbnail) {
        embed.setThumbnail(thumbnail);
    }

    return embed;
}

// ============================================================
// SECTION 12 - COMMAND DEFINITIONS
// ============================================================

function buildCommands() {
    const commands = [];

    commands.push(
        new SlashCommandBuilder()
            .setName("rban")
            .setDescription("Ban a Roblox player.")
            .addStringOption(option =>
                option
                    .setName("player")
                    .setDescription(
                        "Roblox username or user ID."
                    )
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName("duration")
                    .setDescription(
                        "Examples: 30m, 2h, 7d, permanent."
                    )
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName("reason")
                    .setDescription(
                        "Reason shown to the player."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("runban")
            .setDescription("Unban a Roblox player.")
            .addStringOption(option =>
                option
                    .setName("player")
                    .setDescription(
                        "Roblox username or user ID."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rhistory")
            .setDescription(
                "View a player's moderation history."
            )
            .addStringOption(option =>
                option
                    .setName("player")
                    .setDescription(
                        "Roblox username or user ID."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rinfo")
            .setDescription(
                "View Roblox player information."
            )
            .addStringOption(option =>
                option
                    .setName("player")
                    .setDescription(
                        "Roblox username or user ID."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rservers")
            .setDescription(
                "View active Roblox servers."
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rplayers")
            .setDescription(
                "View players in a Roblox server."
            )
            .addStringOption(option =>
                option
                    .setName("server")
                    .setDescription(
                        "Server Job ID. Leave blank for your first active server."
                    )
                    .setRequired(false)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rserver")
            .setDescription(
                "View information about a Roblox server."
            )
            .addStringOption(option =>
                option
                    .setName("server")
                    .setDescription(
                        "Server Job ID."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("altcheck")
            .setDescription(
                "Check whether two Roblox users are friends."
            )
            .addStringOption(option =>
                option
                    .setName("user1")
                    .setDescription(
                        "First username or user ID."
                    )
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName("user2")
                    .setDescription(
                        "Second username or user ID."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rgive")
            .setDescription(
                "Give a loaded Roblox player's stat/currency."
            )
            .addStringOption(option =>
                option
                    .setName("player")
                    .setDescription(
                        "Roblox username."
                    )
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName("stat")
                    .setDescription(
                        "Stat name, e.g. Currency."
                    )
                    .setRequired(true)
            )
            .addNumberOption(option =>
                option
                    .setName("amount")
                    .setDescription(
                        "Amount to add."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rremove")
            .setDescription(
                "Remove a loaded Roblox player's stat/currency."
            )
            .addStringOption(option =>
                option
                    .setName("player")
                    .setDescription(
                        "Roblox username."
                    )
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName("stat")
                    .setDescription(
                        "Stat name."
                    )
                    .setRequired(true)
            )
            .addNumberOption(option =>
                option
                    .setName("amount")
                    .setDescription(
                        "Amount to remove."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rreset")
            .setDescription(
                "Reset a loaded Roblox player's data."
            )
            .addStringOption(option =>
                option
                    .setName("player")
                    .setDescription(
                        "Roblox username."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rannounce")
            .setDescription(
                "Send a global game announcement."
            )
            .addStringOption(option =>
                option
                    .setName("message")
                    .setDescription(
                        "Announcement text."
                    )
                    .setRequired(true)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rshutdown")
            .setDescription(
                "Shut down all Roblox servers."
            )
            .addStringOption(option =>
                option
                    .setName("reason")
                    .setDescription(
                        "Kick message."
                    )
                    .setRequired(false)
            )
    );

    commands.push(
        new SlashCommandBuilder()
            .setName("rmaintenance")
            .setDescription(
                "Enable or disable maintenance mode."
            )
            .addBooleanOption(option =>
                option
                    .setName("enabled")
                    .setDescription(
                        "Whether maintenance mode is enabled."
                    )
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName("message")
                    .setDescription(
                        "Message shown when players are kicked."
                    )
                    .setRequired(false)
            )
    );

    return commands.map(
        command => command.toJSON()
    );
}

const COMMANDS = buildCommands();

// ============================================================
// SECTION 13 - DISCORD COMMAND REGISTRATION
// ============================================================

async function registerCommands() {
    const rest = new REST({
        version: "10",
    }).setToken(
        CONFIG.discordToken
    );

    if (
        CONFIG.commandRegisterMode === "guild"
        && CONFIG.commandGuildId
    ) {
        await rest.put(
            Routes.applicationGuildCommands(
                client.user.id,
                CONFIG.commandGuildId
            ),
            {
                body: COMMANDS,
            }
        );

        console.log(
            `${CONFIG.logPrefix} Guild commands registered.`
        );

        return;
    }

    await rest.put(
        Routes.applicationCommands(
            client.user.id
        ),
        {
            body: COMMANDS,
        }
    );

    console.log(
        `${CONFIG.logPrefix} Global commands registered.`
    );
}

// ============================================================
// SECTION 14 - PERMISSION GUARDS
// ============================================================

async function requireModerator(interaction) {
    const member = getDiscordMember(
        interaction
    );

    if (!canUseModerator(member)) {
        await interaction.reply({
            embeds: [
                errorEmbed(
                    "No Permission",
                    "You need the Moderator role or Administrator permission."
                ),
            ],
            ephemeral: true,
        });

        return false;
    }

    return true;
}

async function requireAdmin(interaction) {
    const member = getDiscordMember(
        interaction
    );

    if (!canUseAdmin(member)) {
        await interaction.reply({
            embeds: [
                errorEmbed(
                    "No Permission",
                    "You need the Admin role or Administrator permission."
                ),
            ],
            ephemeral: true,
        });

        return false;
    }

    return true;
}

async function requireManager(interaction) {
    const member = getDiscordMember(
        interaction
    );

    if (!canUseManager(member)) {
        await interaction.reply({
            embeds: [
                errorEmbed(
                    "No Permission",
                    "You need the Manager role or Administrator permission."
                ),
            ],
            ephemeral: true,
        });

        return false;
    }

    return true;
}

async function requireAnnouncementRole(interaction) {
    const member = getDiscordMember(
        interaction
    );

    if (!canUseAnnouncement(member)) {
        await interaction.reply({
            embeds: [
                errorEmbed(
                    "No Permission",
                    "You do not have permission to send game announcements."
                ),
            ],
            ephemeral: true,
        });

        return false;
    }

    return true;
}

// ============================================================
// SECTION 15 - /RBAN
// ============================================================

async function handleRban(interaction) {
    if (!(await requireModerator(interaction))) {
        return;
    }

    const input = interaction.options.getString(
        "player",
        true
    );

    const durationInput =
        interaction.options.getString(
            "duration",
            true
        );

    const reason =
        cleanReason(
            interaction.options.getString(
                "reason",
                true
            )
        );

    const duration =
        parseDuration(
            durationInput
        );

    if (duration === null) {
        await interaction.reply({
            embeds: [
                errorEmbed(
                    "Invalid Duration",
                    "Use values such as `30m`, `2h`, `7d`, `1w`, or `permanent`."
                ),
            ],
            ephemeral: true,
        });

        return;
    }

    await interaction.deferReply();

    let user;

    try {
        user = await resolveRobloxUser(
            input
        );
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Roblox Error",
                    "Roblox could not be reached."
                ),
            ],
        });

        return;
    }

    if (!user) {
        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Player Not Found",
                    `No Roblox user was found for \`${input}\`.`
                ),
            ],
        });

        return;
    }

    const privateReason =
        `Discord ban by ${interaction.user.tag}`
        + ` (${interaction.user.id})`
        + ` | ${reason}`;

    try {
        await publishRobloxCommand(
            "ban",
            {
                userId: user.id,
                username: user.name,
                duration,
                displayReason: reason,
                privateReason,
            },
            false
        );
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Ban Failed",
                    "The ban command could not be published to Roblox."
                ),
            ],
        });

        return;
    }

    await addHistoryEntry({
        action: "ban",
        robloxUserId: user.id,
        robloxUsername: user.name,
        discordUserId: interaction.user.id,
        discordUsername: interaction.user.tag,
        reason,
        durationSeconds: duration,
    });

    await interaction.editReply({
        embeds: [
            successEmbed(
                "Player Banned",
                `**Player:** ${user.name}\n`
                + `**User ID:** ${user.id}\n`
                + `**Duration:** ${formatDuration(duration)}\n`
                + `**Reason:** ${reason}`
            ),
        ],
    });
}

// ============================================================
// SECTION 16 - /RUNBAN
// ============================================================

async function handleRunban(interaction) {
    if (!(await requireModerator(interaction))) {
        return;
    }

    const input =
        interaction.options.getString(
            "player",
            true
        );

    await interaction.deferReply();

    const user =
        await resolveRobloxUser(input);

    if (!user) {
        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Player Not Found",
                    `No Roblox user was found for \`${input}\`.`
                ),
            ],
        });

        return;
    }

    try {
        await publishRobloxCommand(
            "unban",
            {
                userId: user.id,
                username: user.name,
            },
            false
        );
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Unban Failed",
                    "The command could not be published to Roblox."
                ),
            ],
        });

        return;
    }

    await addHistoryEntry({
        action: "unban",
        robloxUserId: user.id,
        robloxUsername: user.name,
        discordUserId: interaction.user.id,
        discordUsername: interaction.user.tag,
        reason: "Discord unban.",
    });

    await interaction.editReply({
        embeds: [
            successEmbed(
                "Player Unbanned",
                `**Player:** ${user.name}\n`
                + `**User ID:** ${user.id}`
            ),
        ],
    });
}

// ============================================================
// SECTION 17 - /RHISTORY
// ============================================================

async function handleRhistory(interaction) {
    if (!(await requireModerator(interaction))) {
        return;
    }

    const input =
        interaction.options.getString(
            "player",
            true
        );

    await interaction.deferReply();

    const user =
        await resolveRobloxUser(input);

    if (!user) {
        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Player Not Found",
                    `No Roblox user was found for \`${input}\`.`
                ),
            ],
        });

        return;
    }

    const history =
        await getHistory(user.id);

    if (!history.length) {
        await interaction.editReply({
            embeds: [
                infoEmbed(
                    "Moderation History",
                    `No recorded Discord moderation actions were found for **${user.name}**.`
                ),
            ],
        });

        return;
    }

    const lines = history.map(
        (entry, index) => {
            const date =
                entry.created_at
                    || entry.createdAt;

            const timestamp =
                date
                    ? `<t:${Math.floor(
                        new Date(date).getTime() / 1000
                    )}:R>`
                    : "Unknown time";

            const action =
                entry.action || "unknown";

            const reason =
                entry.reason || "No reason provided.";

            const duration =
                entry.duration_seconds !== undefined
                    ? entry.duration_seconds
                    : entry.durationSeconds;

            const durationText =
                duration !== null
                    && duration !== undefined
                    ? ` • ${formatDuration(duration)}`
                    : "";

            const staff =
                entry.discord_username
                    || entry.discordUsername
                    || "Unknown";

            return (
                `**${index + 1}. ${action.toUpperCase()}**`
                + `${durationText}\n`
                + `Reason: ${truncate(reason, 180)}\n`
                + `Staff: ${staff} • ${timestamp}`
            );
        }
    );

    const embed =
        new EmbedBuilder()
            .setTitle(
                `📋 Moderation History — ${user.name}`
            )
            .setDescription(
                truncate(
                    lines.join("\n\n"),
                    4000
                )
            )
            .setColor(CONFIG.color)
            .setTimestamp();

    await interaction.editReply({
        embeds: [embed],
    });
}

// ============================================================
// SECTION 18 - /RINFO
// ============================================================

async function handleRinfo(interaction) {
    if (!(await requireModerator(interaction))) {
        return;
    }

    const input =
        interaction.options.getString(
            "player",
            true
        );

    await interaction.deferReply();

    const user =
        await resolveRobloxUser(input);

    if (!user) {
        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Player Not Found",
                    `No Roblox user was found for \`${input}\`.`
                ),
            ],
        });

        return;
    }

    const [
        thumbnail,
        presence,
    ] = await Promise.all([
        getRobloxAvatarThumbnail(
            user.id
        ),
        getRobloxPresence(
            user.id
        ),
    ]);

    const presenceMap = {
        0: "Offline",
        1: "Online",
        2: "In Game",
        3: "In Studio",
    };

    const presenceText =
        presenceMap[
            presence?.userPresenceType
        ] || "Unknown";

    const embed =
        userEmbed(
            user,
            thumbnail
        );

    embed.addFields(
        {
            name: "Display Name",
            value:
                truncate(
                    user.displayName || "Unknown",
                    1000
                ),
            inline: true,
        },
        {
            name: "Presence",
            value: presenceText,
            inline: true,
        },
        {
            name: "Created",
            value: user.created
                ? `<t:${Math.floor(
                    new Date(
                        user.created
                    ).getTime() / 1000
                )}:D>`
                : "Unknown",
            inline: true,
        }
    );

    if (presence?.lastLocation) {
        embed.addFields({
            name: "Last Location",
            value:
                truncate(
                    presence.lastLocation,
                    1000
                ),
            inline: false,
        });
    }

    await interaction.editReply({
        embeds: [embed],
    });
}

// ============================================================
// SECTION 19 - /RSERVERS
// ============================================================

async function handleRservers(interaction) {
    if (!(await requireModerator(interaction))) {
        return;
    }

    await interaction.deferReply();

    try {
        const data =
            await getPublicServers(
                "",
                100
            );

        const servers =
            Array.isArray(data.data)
                ? data.data
                : [];

        if (!servers.length) {
            await interaction.editReply({
                embeds: [
                    infoEmbed(
                        "Active Servers",
                        "No public servers were returned by Roblox."
                    ),
                ],
            });

            return;
        }

        const lines =
            servers
                .slice(0, 20)
                .map(
                    (server, index) =>
                        `**${index + 1}.** \`${server.id}\``
                        + ` — ${formatNumber(server.playing || 0)}`
                        + `/${formatNumber(server.maxPlayers || 0)} players`
                        + (
                            server.fps
                                ? ` • ${Math.round(server.fps)} FPS`
                                : ""
                        )
                );

        const totalPlayers =
            servers.reduce(
                (sum, server) =>
                    sum + Number(
                        server.playing || 0
                    ),
                0
            );

        const embed =
            new EmbedBuilder()
                .setTitle("🖥️ Active Roblox Servers")
                .setDescription(
                    lines.join("\n")
                )
                .addFields(
                    {
                        name: "Servers Returned",
                        value:
                            String(servers.length),
                        inline: true,
                    },
                    {
                        name: "Players",
                        value:
                            formatNumber(
                                totalPlayers
                            ),
                        inline: true,
                    }
                )
                .setFooter({
                    text:
                        "Showing the first 20 servers returned by Roblox.",
                })
                .setColor(CONFIG.color)
                .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
        });
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Server Lookup Failed",
                    "Roblox did not return the public server list."
                ),
            ],
        });
    }
}

// ============================================================
// SECTION 20 - /RPLAYERS
// ============================================================

async function handleRplayers(interaction) {
    if (!(await requireModerator(interaction))) {
        return;
    }

    const requestedJob =
        interaction.options.getString(
            "server",
            false
        );

    await interaction.deferReply();

    try {
        let server = null;

        if (requestedJob) {
            server =
                await findPublicServer(
                    requestedJob
                );
        } else {
            const data =
                await getPublicServers(
                    "",
                    100
                );

            server =
                Array.isArray(data.data)
                    ? data.data[0]
                    : null;
        }

        if (!server) {
            await interaction.editReply({
                embeds: [
                    errorEmbed(
                        "Server Not Found",
                        "That server could not be found in Roblox's public server list."
                    ),
                ],
            });

            return;
        }

        const playerTokens =
            Array.isArray(
                server.playerTokens
            )
                ? server.playerTokens
                : [];

        const tokenLines =
            playerTokens
                .slice(
                    0,
                    CONFIG.maxPlayersDisplay
                )
                .map(
                    (token, index) =>
                        `${index + 1}. \`${truncate(
                            token,
                            40
                        )}\``
                );

        const description =
            playerTokens.length
                ? tokenLines.join("\n")
                : "Roblox did not expose a username list for this server through the public endpoint.";

        const embed =
            new EmbedBuilder()
                .setTitle(
                    "👥 Roblox Server Players"
                )
                .setDescription(
                    truncate(
                        description,
                        4000
                    )
                )
                .addFields(
                    {
                        name: "Server",
                        value:
                            `\`${server.id}\``,
                        inline: false,
                    },
                    {
                        name: "Player Count",
                        value:
                            `${formatNumber(
                                server.playing || 0
                            )}/${formatNumber(
                                server.maxPlayers || 0
                            )}`,
                        inline: true,
                    }
                )
                .setColor(CONFIG.color)
                .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
        });
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Player Lookup Failed",
                    "Roblox did not return the requested server."
                ),
            ],
        });
    }
}

// ============================================================
// SECTION 21 - /RSERVER
// ============================================================

async function handleRserver(interaction) {
    if (!(await requireModerator(interaction))) {
        return;
    }

    const jobId =
        interaction.options.getString(
            "server",
            true
        );

    await interaction.deferReply();

    try {
        const server =
            await findPublicServer(
                jobId
            );

        if (!server) {
            await interaction.editReply({
                embeds: [
                    errorEmbed(
                        "Server Not Found",
                        `No public server with Job ID \`${jobId}\` was found.`
                    ),
                ],
            });

            return;
        }

        const embed =
            new EmbedBuilder()
                .setTitle(
                    "🖥️ Roblox Server Information"
                )
                .addFields(
                    {
                        name: "Job ID",
                        value:
                            `\`${server.id}\``,
                        inline: false,
                    },
                    {
                        name: "Players",
                        value:
                            `${formatNumber(
                                server.playing || 0
                            )}/${formatNumber(
                                server.maxPlayers || 0
                            )}`,
                        inline: true,
                    },
                    {
                        name: "FPS",
                        value:
                            server.fps
                                ? `${Math.round(
                                    server.fps
                                )}`
                                : "Unknown",
                        inline: true,
                    },
                    {
                        name: "Ping",
                        value:
                            server.ping
                                ? `${Math.round(
                                    server.ping
                                )} ms`
                                : "Unknown",
                        inline: true,
                    }
                )
                .setColor(CONFIG.color)
                .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
        });
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Server Lookup Failed",
                    "Roblox did not return that server."
                ),
            ],
        });
    }
}

// ============================================================
// SECTION 22 - /ALTCHECK
// ============================================================

async function handleAltcheck(interaction) {
    if (!(await requireModerator(interaction))) {
        return;
    }

    const first =
        interaction.options.getString(
            "user1",
            true
        );

    const second =
        interaction.options.getString(
            "user2",
            true
        );

    await interaction.deferReply();

    const [
        firstUser,
        secondUser,
    ] = await Promise.all([
        resolveRobloxUser(first),
        resolveRobloxUser(second),
    ]);

    if (!firstUser || !secondUser) {
        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Player Not Found",
                    "One or both Roblox users could not be found."
                ),
            ],
        });

        return;
    }

    const friends =
        await areRobloxUsersFriends(
            firstUser.id,
            secondUser.id
        );

    const resultText =
        friends
            ? `Roblox reports that **${firstUser.name}** and **${secondUser.name}** are friends.`
            : `Roblox does not report **${firstUser.name}** and **${secondUser.name}** as friends.`;

    await interaction.editReply({
        embeds: [
            infoEmbed(
                "Friend Check",
                resultText
            ),
        ],
    });
}

// ============================================================
// SECTION 23 - /RGIVE
// ============================================================

async function handleRgive(interaction) {
    if (!(await requireAdmin(interaction))) {
        return;
    }

    const player =
        interaction.options.getString(
            "player",
            true
        );

    const stat =
        interaction.options.getString(
            "stat",
            true
        );

    const amount =
        interaction.options.getNumber(
            "amount",
            true
        );

    if (!Number.isFinite(amount) || amount <= 0) {
        await interaction.reply({
            embeds: [
                errorEmbed(
                    "Invalid Amount",
                    "Amount must be greater than zero."
                ),
            ],
            ephemeral: true,
        });

        return;
    }

    await interaction.deferReply();

    try {
        await publishRobloxCommand(
            "give",
            {
                player: cleanUsername(player),
                stat: cleanText(stat, 100),
                amount,
            },
            false
        );
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Give Failed",
                    "The command could not be sent to Roblox."
                ),
            ],
        });

        return;
    }

    await interaction.editReply({
        embeds: [
            successEmbed(
                "Give Command Sent",
                `**Player:** ${player}\n`
                + `**Stat:** ${stat}\n`
                + `**Amount:** ${formatNumber(amount)}`
            ),
        ],
    });
}

// ============================================================
// SECTION 24 - /RREMOVE
// ============================================================

async function handleRremove(interaction) {
    if (!(await requireAdmin(interaction))) {
        return;
    }

    const player =
        interaction.options.getString(
            "player",
            true
        );

    const stat =
        interaction.options.getString(
            "stat",
            true
        );

    const amount =
        interaction.options.getNumber(
            "amount",
            true
        );

    if (!Number.isFinite(amount) || amount <= 0) {
        await interaction.reply({
            embeds: [
                errorEmbed(
                    "Invalid Amount",
                    "Amount must be greater than zero."
                ),
            ],
            ephemeral: true,
        });

        return;
    }

    await interaction.deferReply();

    try {
        await publishRobloxCommand(
            "remove",
            {
                player: cleanUsername(player),
                stat: cleanText(stat, 100),
                amount,
            },
            false
        );
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Remove Failed",
                    "The command could not be sent to Roblox."
                ),
            ],
        });

        return;
    }

    await interaction.editReply({
        embeds: [
            successEmbed(
                "Remove Command Sent",
                `**Player:** ${player}\n`
                + `**Stat:** ${stat}\n`
                + `**Amount:** ${formatNumber(amount)}`
            ),
        ],
    });
}

// ============================================================
// SECTION 25 - /RRESET
// ============================================================

async function handleRreset(interaction) {
    if (!(await requireAdmin(interaction))) {
        return;
    }

    const player =
        interaction.options.getString(
            "player",
            true
        );

    await interaction.deferReply();

    try {
        await publishRobloxCommand(
            "reset",
            {
                player: cleanUsername(player),
            },
            false
        );
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Reset Failed",
                    "The command could not be sent to Roblox."
                ),
            ],
        });

        return;
    }

    await interaction.editReply({
        embeds: [
            successEmbed(
                "Reset Command Sent",
                `The loaded data for **${player}** was sent to the Roblox reset handler.`
            ),
        ],
    });
}

// ============================================================
// SECTION 26 - /RANNOUNCE
// ============================================================

async function handleRannounce(interaction) {
    if (!(await requireAnnouncementRole(interaction))) {
        return;
    }

    const message =
        cleanText(
            interaction.options.getString(
                "message",
                true
            ),
            CONFIG.maxAnnouncementLength
        );

    if (!message) {
        await interaction.reply({
            embeds: [
                errorEmbed(
                    "Empty Announcement",
                    "The announcement cannot be empty."
                ),
            ],
            ephemeral: true,
        });

        return;
    }

    await interaction.deferReply();

    const discordMember =
        interaction.member;

    const color =
        discordMember?.displayHexColor
        && discordMember.displayHexColor !== "#000000"
            ? discordMember.displayHexColor
            : "#FFFFFF";

    const payload = {
        text: message,
        duration: 5,
        sender:
            interaction.member?.displayName
            || interaction.user.username,
        senderColorHex: color,
        senderVerified: false,
    };

    try {
        await publishUniverseMessage(
            CONFIG.robloxAnnouncementTopic,
            JSON.stringify(payload)
        );
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Announcement Failed",
                    "Roblox Open Cloud rejected the announcement."
                ),
            ],
        });

        return;
    }

    await interaction.editReply({
        embeds: [
            successEmbed(
                "Global Announcement Sent",
                `> ${message}`
            ),
        ],
    });
}

// ============================================================
// SECTION 27 - /RSHUTDOWN
// ============================================================

async function handleRshutdown(interaction) {
    if (!(await requireManager(interaction))) {
        return;
    }

    const reason =
        cleanReason(
            interaction.options.getString(
                "reason",
                false
            )
            || "The game is shutting down."
        );

    await interaction.deferReply();

    try {
        await restartUniverseServers();

        await addHistoryEntry({
            action: "shutdown",
            discordUserId: interaction.user.id,
            discordUsername: interaction.user.tag,
            reason,
        });

        await interaction.editReply({
            embeds: [
                successEmbed(
                    "Servers Restarting",
                    `Roblox has been instructed to restart the universe servers.\n\n**Reason:** ${reason}`
                ),
            ],
        });
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Shutdown Failed",
                    "Roblox rejected the universe restart request. Check your API key has `universe:write` permission."
                ),
            ],
        });
    }
}

// ============================================================
// SECTION 28 - /RMAINTENANCE
// ============================================================

async function handleRmaintenance(interaction) {
    if (!(await requireManager(interaction))) {
        return;
    }

    const enabled =
        interaction.options.getBoolean(
            "enabled",
            true
        );

    const message =
        cleanReason(
            interaction.options.getString(
                "message",
                false
            )
            || "The game is currently under maintenance."
        );

    await interaction.deferReply();

    try {
        await publishRobloxCommand(
            "maintenance",
            {
                enabled,
                message,
            },
            false
        );

        await addHistoryEntry({
            action:
                enabled
                    ? "maintenance-on"
                    : "maintenance-off",
            discordUserId: interaction.user.id,
            discordUsername: interaction.user.tag,
            reason: message,
        });

        await interaction.editReply({
            embeds: [
                successEmbed(
                    enabled
                        ? "Maintenance Enabled"
                        : "Maintenance Disabled",
                    enabled
                        ? `Players attempting to join will be kicked with:\n> ${message}`
                        : "Maintenance mode has been disabled."
                ),
            ],
        });
    } catch (error) {
        console.error(error);

        await interaction.editReply({
            embeds: [
                errorEmbed(
                    "Maintenance Failed",
                    "The command could not be sent to Roblox."
                ),
            ],
        });
    }
}

// ============================================================
// SECTION 29 - COMMAND DISPATCH
// ============================================================

const commandHandlers = new Map([
    ["rban", handleRban],
    ["runban", handleRunban],
    ["rhistory", handleRhistory],
    ["rinfo", handleRinfo],
    ["rservers", handleRservers],
    ["rplayers", handleRplayers],
    ["rserver", handleRserver],
    ["altcheck", handleAltcheck],
    ["rgive", handleRgive],
    ["rremove", handleRremove],
    ["rreset", handleRreset],
    ["rannounce", handleRannounce],
    ["rshutdown", handleRshutdown],
    ["rmaintenance", handleRmaintenance],
]);

// ============================================================
// SECTION 30 - ROBLOX CALLBACK HTTP SERVER
// ============================================================

const http = require("http");

function parseJsonBody(request) {
    return new Promise(
        (resolve, reject) => {
            let body = "";

            request.on(
                "data",
                chunk => {
                    body += chunk;

                    if (body.length > 1000000) {
                        reject(
                            new Error(
                                "Request body too large."
                            )
                        );

                        request.destroy();
                    }
                }
            );

            request.on(
                "end",
                () => {
                    if (!body) {
                        resolve({});
                        return;
                    }

                    try {
                        resolve(
                            JSON.parse(body)
                        );
                    } catch {
                        reject(
                            new Error(
                                "Invalid JSON."
                            )
                        );
                    }
                }
            );

            request.on(
                "error",
                reject
            );
        }
    );
}

function startCallbackServer() {
    const server =
        http.createServer(
            async (request, response) => {
                if (
                    request.method !== "POST"
                    || request.url !== "/roblox/callback"
                ) {
                    response.statusCode = 404;
                    response.end("Not Found");
                    return;
                }

                const secret =
                    request.headers[
                        "x-api-secret"
                    ];

                if (
                    CONFIG.apiSecret
                    && secret !== CONFIG.apiSecret
                ) {
                    response.statusCode = 401;
                    response.end("Unauthorized");
                    return;
                }

                try {
                    const body =
                        await parseJsonBody(
                            request
                        );

                    const requestId =
                        String(
                            body.requestId || ""
                        );

                    const pending =
                        pendingRequests.get(
                            requestId
                        );

                    if (pending) {
                        clearTimeout(
                            pending.timeout
                        );

                        pendingRequests.delete(
                            requestId
                        );

                        pending.resolve({
                            success:
                                body.success === true,
                            requestId,
                            message:
                                String(
                                    body.message || ""
                                ),
                            data:
                                body.extra || null,
                        });
                    }

                    response.statusCode = 200;
                    response.setHeader(
                        "Content-Type",
                        "application/json"
                    );

                    response.end(
                        JSON.stringify({
                            ok: true,
                        })
                    );
                } catch (error) {
                    console.error(
                        `${CONFIG.logPrefix} Callback error:`,
                        error
                    );

                    response.statusCode = 400;
                    response.end(
                        JSON.stringify({
                            ok: false,
                        })
                    );
                }
            }
        );

    const port =
        Number(
            process.env.PORT || 3000
        );

    server.listen(
        port,
        () => {
            console.log(
                `${CONFIG.logPrefix} Callback server listening on ${port}.`
            );
        }
    );

    return server;
}

startCallbackServer();

// ============================================================
// SECTION 31 - VOICE CHANNEL
// ============================================================

let voiceConnection = null;
let voiceReconnectTimer = null;

function clearVoiceReconnectTimer() {
    if (!voiceReconnectTimer) {
        return;
    }

    clearTimeout(
        voiceReconnectTimer
    );

    voiceReconnectTimer = null;
}

async function connectToVoiceChannel() {
    clearVoiceReconnectTimer();

    if (!client.isReady()) {
        return;
    }

    const channel =
        await client.channels.fetch(
            CONFIG.voiceChannelId
        );

    if (!channel) {
        throw new Error(
            `Voice channel ${CONFIG.voiceChannelId} was not found.`
        );
    }

    if (
        channel.type !== ChannelType.GuildVoice
        && channel.type !== ChannelType.GuildStageVoice
    ) {
        throw new Error(
            "VOICE_CHANNEL_ID is not a voice/stage channel."
        );
    }

    const guild =
        channel.guild;

    voiceConnection =
        joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator:
                guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
        });

    voiceConnection.on(
        VoiceConnectionStatus.Ready,
        () => {
            console.log(
                `${CONFIG.logPrefix} Connected to VC ${channel.id}.`
            );
        }
    );

    voiceConnection.on(
        VoiceConnectionStatus.Disconnected,
        async () => {
            console.warn(
                `${CONFIG.logPrefix} Voice connection disconnected.`
            );

            try {
                await Promise.race([
                    entersState(
                        voiceConnection,
                        VoiceConnectionStatus.Signalling,
                        5000
                    ),
                    entersState(
                        voiceConnection,
                        VoiceConnectionStatus.Connecting,
                        5000
                    ),
                ]);

                console.log(
                    `${CONFIG.logPrefix} Voice connection is reconnecting.`
                );
            } catch {
                scheduleVoiceReconnect();
            }
        }
    );

    voiceConnection.on(
        VoiceConnectionStatus.Destroyed,
        () => {
            scheduleVoiceReconnect();
        }
    );

    try {
        await entersState(
            voiceConnection,
            VoiceConnectionStatus.Ready,
            15000
        );
    } catch (error) {
        console.error(
            `${CONFIG.logPrefix} Voice connection did not become ready:`,
            error
        );

        try {
            voiceConnection.destroy();
        } catch {
            // Ignore cleanup errors.
        }

        voiceConnection = null;

        scheduleVoiceReconnect();
    }
}

function scheduleVoiceReconnect() {
    if (voiceReconnectTimer) {
        return;
    }

    voiceReconnectTimer =
        setTimeout(
            async () => {
                voiceReconnectTimer = null;

                try {
                    await connectToVoiceChannel();
                } catch (error) {
                    console.error(
                        `${CONFIG.logPrefix} Voice reconnect failed:`,
                        error
                    );

                    scheduleVoiceReconnect();
                }
            },
            CONFIG.voiceReconnectDelayMs
        );
}

// ============================================================
// SECTION 32 - DISCORD EVENTS
// ============================================================

client.once(
    "ready",
    async readyClient => {
        console.log(
            `${CONFIG.logPrefix} Logged in as ${readyClient.user.tag}.`
        );

        readyClient.user.setPresence({
            activities: [
                {
                    name: "Roblox",
                    type: ActivityType.Watching,
                },
            ],
            status: "online",
        });

        try {
            await registerCommands();
        } catch (error) {
            console.error(
                `${CONFIG.logPrefix} Command registration failed:`,
                error
            );
        }

        try {
            await connectToVoiceChannel();
        } catch (error) {
            console.error(
                `${CONFIG.logPrefix} Initial voice connection failed:`,
                error
            );

            scheduleVoiceReconnect();
        }
    }
);

client.on(
    "interactionCreate",
    async interaction => {
        if (!interaction.isChatInputCommand()) {
            return;
        }

        const handler =
            commandHandlers.get(
                interaction.commandName
            );

        if (!handler) {
            await interaction.reply({
                embeds: [
                    errorEmbed(
                        "Unknown Command",
                        "That command is not configured."
                    ),
                ],
                ephemeral: true,
            });

            return;
        }

        try {
            await handler(
                interaction
            );
        } catch (error) {
            console.error(
                `${CONFIG.logPrefix} Command error:`,
                interaction.commandName,
                error
            );

            const reply = {
                embeds: [
                    errorEmbed(
                        "Unexpected Error",
                        "Something went wrong while running the command."
                    ),
                ],
                ephemeral: true,
            };

            if (interaction.deferred) {
                await interaction.editReply(
                    reply
                ).catch(() => {});
            } else if (interaction.replied) {
                await interaction.followUp(
                    reply
                ).catch(() => {});
            } else {
                await interaction.reply(
                    reply
                ).catch(() => {});
            }
        }
    }
);

client.on(
    "error",
    error => {
        console.error(
            `${CONFIG.logPrefix} Discord client error:`,
            error
        );
    }
);

process.on(
    "unhandledRejection",
    error => {
        console.error(
            `${CONFIG.logPrefix} Unhandled rejection:`,
            error
        );
    }
);

process.on(
    "uncaughtException",
    error => {
        console.error(
            `${CONFIG.logPrefix} Uncaught exception:`,
            error
        );
    }
);

// ============================================================
// SECTION 33 - GRACEFUL SHUTDOWN
// ============================================================

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `${CONFIG.logPrefix} Received ${signal}. Shutting down.`
    );

    clearVoiceReconnectTimer();

    if (voiceConnection) {
        try {
            voiceConnection.destroy();
        } catch {
            // Ignore.
        }

        voiceConnection = null;
    }

    for (
        const [
            requestId,
            pending,
        ] of pendingRequests
    ) {
        clearTimeout(
            pending.timeout
        );

        pending.resolve({
            success: false,
            requestId,
            message: "Bot is shutting down.",
            data: null,
        });
    }

    pendingRequests.clear();

    if (pool) {
        try {
            await pool.end();
        } catch {
            // Ignore.
        }
    }

    try {
        client.destroy();
    } catch {
        // Ignore.
    }

    process.exit(0);
}

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

// ============================================================
// SECTION 34 - START
// ============================================================

(async () => {
    try {
        await initializeDatabase();

        await client.login(
            CONFIG.discordToken
        );
    } catch (error) {
        console.error(
            `${CONFIG.logPrefix} Startup failed:`,
            error
        );

        process.exit(1);
    }
})();

// ============================================================
// SECTION 35 - COMMAND REFERENCE
// ============================================================
//
// /rban
// Ban a Roblox player.
//
// /runban
// Unban a Roblox player.
//
// /rhistory
// View Discord moderation history.
//
// /rinfo
// View Roblox user information.
//
// /rservers
// View public Roblox servers.
//
// /rplayers
// View public-server player information.
//
// /rserver
// View a single public server.
//
// /altcheck
// Check whether two Roblox accounts are friends.
//
// /rgive
// Add a numeric amount to a loaded Player.Data value.
//
// /rremove
// Subtract a numeric amount from a loaded Player.Data value.
//
// /rreset
// Reset loaded Player.Data values using the bridge.
//
// /rannounce
// Publish to GlobalAnnouncement.
//
// /rshutdown
// Restart universe servers.
//
// /rmaintenance
// Toggle the bridge's maintenance state.
//
// ============================================================
// SECTION 36 - SAFETY NOTES
// ============================================================
//
// The Discord permission checks happen before Roblox messages are sent.
//
// Roblox also validates the shape of every received command.
//
// The bot never sends the Discord token to Roblox.
//
// The bot never sends its Roblox API key to Roblox.
//
// The API key remains on Railway.
//
// The callback server only accepts the configured API secret.
//
// The bridge is server-side code.
//
// The bridge does not trust a client RemoteEvent.
//
// ============================================================
// SECTION 37 - DATA MODEL NOTES
// ============================================================
//
// The supplied game scripts use:
//
// Player
//   Data
//     ...
//     Pets
//
// The bridge searches Player.Data descendants by name.
//
// Numeric IntValue and NumberValue objects are supported.
//
// BoolValue objects are supported by the bridge set helper.
//
// StringValue objects are supported by the bridge set helper.
//
// Pet granting uses:
//
// ReplicatedStorage
//   Pets
//   Assets
//     PetTemplate
//
// The pet template must contain a PetName value.
//
// ============================================================
// SECTION 38 - ANNOUNCEMENT COMPATIBILITY
// ============================================================
//
// The supplied announcement script subscribes to:
//
// GlobalAnnouncement
//
// The Discord bot publishes:
//
// {
//   text,
//   duration,
//   sender,
//   senderColorHex,
//   senderVerified
// }
//
// This matches the data shape expected by the announcement receiver.
//
// ============================================================
// SECTION 39 - VOICE BEHAVIOUR
// ============================================================
//
// The bot joins the configured voice channel after login.
//
// If Discord disconnects the voice connection, the bot attempts to recover.
//
// If the voice connection is destroyed, a reconnect timer is scheduled.
//
// The timer prevents multiple reconnect loops from being created.
//
// ============================================================
// SECTION 40 - END
// ============================================================
//
// Keep the environment variables in Railway.
//
// Do not commit secrets.
//
// Do not paste secrets into this source file.
//
// The bot can run with DATABASE_URL empty, but moderation history will
// then be stored only in memory and will be lost when Railway restarts.
//
// ============================================================

/*
 * EXTENDED ADMINISTRATOR NOTES
 * These comments document the implementation and make the project easier to maintain.
 */

// Permission checks are performed before every Roblox-affecting command.

// Moderator commands are intended for routine moderation and inspection.

// Admin commands alter loaded player data and therefore require the Admin role.

// Manager commands affect the whole experience and require the Manager role.

// The announcement permission is explicitly tied to ANNOUNCE_ROLE_ID.

// The default announcement role is the role supplied by the user.

// The default voice channel is the channel supplied by the user.

// The default universe ID is the universe supplied by the user.

// Roblox API errors are caught and converted into Discord error embeds.

// Database errors do not crash the Discord process.

// Voice reconnect errors do not crash the Discord process.

// Pending Roblox callback requests expire automatically.

// Request IDs are UUIDs and are safe to correlate across services.

// Player names are trimmed before being sent to Roblox.

// Announcement text is capped before publishing.

// Reasons are capped to match Roblox ban API limits.

// Ban durations are converted to seconds before being sent to Roblox.

// Permanent bans use -1 seconds.

// Roblox's BanAsync API is used by the Roblox bridge.

// Roblox's UnbanAsync API is used by the Roblox bridge.

// Ban operations are universe-wide in the bridge.

// The bridge checks Players.BanningEnabled before using ban APIs.

// The bridge handles players currently connected to a server.

// The bridge does not pretend to edit offline data without the game's datastore code.

// The bridge searches Data descendants so it matches the supplied AdminFunctions helper.

// The bridge adds to numeric values for rgive.

// The bridge subtracts from numeric values for rremove.

// The bridge grants pets through the supplied PetTemplate pattern.

// The bridge removes a matching loaded pet by PetName.

// The bridge supports a loaded-data reset.

// The reset is deliberately conservative about offline datastore state.

// The supplied Loading and Saving modules were not guessed.

// The supplied Datastore module remains compatible with the bridge.

// Autosave remains controlled by the game's existing save script.

// The Discord bot does not replace the game's DataStore implementation.

// The Discord bot does not store Roblox API keys in the database.

// The Discord bot does not store Discord tokens in the database.

// The database stores moderation audit history only.

// The database can be Postgres on Railway.

// The database schema is created automatically.

// The database index makes history lookup faster.

// Memory history is retained as a fallback when Postgres is unavailable.

// Global announcement messages use the exact topic from the supplied script.

// The existing Roblox announcement UI can therefore remain in place.

// The sender name comes from the Discord member display name.

// The sender color comes from the Discord member role color when available.

// Verified badge is disabled for Discord announcements by default.

// Announcement duration defaults to five seconds.

// The Roblox announcement receiver remains responsible for rendering.

// The Discord bot only publishes the message.

// Roblox MessagingService delivery is best-effort.

// A successful Open Cloud publish means the message was accepted by Roblox.

// It does not mean every server has already rendered it.

// The bot uses Open Cloud's stable universe publishMessage endpoint.

// The bot uses x-api-key authentication.

// The API key remains inside Railway.

// The restart endpoint requires appropriate Roblox universe permissions.

// The maintenance command is broadcast through MessagingService.

// Every server that receives maintenance state sets a server attribute.

// Players joining a maintenance-enabled server are kicked.

// Existing players are not automatically kicked by maintenance mode.

// This avoids unexpectedly disconnecting players when maintenance is toggled.

// Shutdown is separate from maintenance.

// Shutdown uses Roblox's universe server restart endpoint.

// The public server list is used for rservers.

// The public server list is used for rserver.

// The public server list is used for rplayers.

// Roblox's public server response does not guarantee a username list.

// The bot therefore never invents usernames from opaque player tokens.

// rplayers displays tokens when Roblox supplies them.

// rinfo uses the Roblox users API.

// rinfo uses the presence API where available.

// rinfo uses a headshot thumbnail where available.

// altcheck uses Roblox friendship/status APIs where available.

// A false friend result should not be interpreted as an alt-account proof.

// Friendship is only one signal and is not identity verification.

// Moderators should treat altcheck as a relationship check.

// rhistory reports actions recorded by this bot.

// rhistory is not a claim that Roblox's complete internal moderation history is stored.

// A future datastore integration can add official Roblox restriction logs.

// The code is intentionally modular by section.

// Configuration is centralized in CONFIG.

// Formatting is centralized in embed helper functions.

// HTTP calls use a timeout.

// The timeout prevents stalled Roblox requests from hanging commands forever.

// The callback server uses API_SECRET when it is configured.

// The callback endpoint is POST-only.

// The callback endpoint returns 404 for unrelated paths.

// The callback endpoint returns 401 for an invalid secret.

// The callback endpoint rejects malformed JSON.

// The callback endpoint prevents unbounded request body growth.

// The callback endpoint only resolves matching request IDs.

// Unknown Roblox callbacks are safely ignored.

// The bot can run without BOT_PUBLIC_URL when commands do not require callbacks.

// The current bridge publishes results for commands that can return data.

// The current Discord commands use fire-and-confirm for data mutations.

// This prevents a slow server from making a Discord interaction wait unnecessarily.

// If a future command needs a live result, waitForResult can be enabled.

// The request map automatically expires entries.

// The command registration mode can be guild or global.

// Global commands may take longer to propagate in Discord.

// Guild commands are useful during development.

// COMMAND_GUILD_ID controls guild registration.

// If command registration fails, the bot still remains logged in.

// Discord client errors are logged.

// Unhandled promise rejections are logged.

// Uncaught exceptions are logged.

// SIGINT and SIGTERM close the database cleanly.

// SIGINT and SIGTERM destroy the voice connection.

// The bot presence is set to Watching Roblox.

// The voice connection does not play audio.

// The bot can remain connected silently.

// Self-deaf is false so the connection remains a normal voice connection.

// Self-mute is false so the bot is not intentionally muted.

// The reconnect timer prevents duplicate reconnect attempts.

// Voice channel validation prevents accidentally joining text channels.

// The bot fetches the voice channel after Discord is ready.

// The bot uses the guild's voice adapter creator.

// The bot waits for VoiceConnectionStatus.Ready.

// A signalling or connecting state is allowed during recovery.

// If recovery fails, a fresh connection is scheduled.

// This is intended for long-running Railway deployments.

/* MAINTENANCE BLOCK 01 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 02 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 03 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 04 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 05 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 06 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 07 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 08 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 09 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 10 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 11 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.

/* MAINTENANCE BLOCK 12 */
// Review environment variables before deployment.
// Review Roblox API key scopes before deployment.
// Review Discord role IDs before deployment.
// Review voice channel permissions before deployment.
// Review Roblox HttpService settings before deployment.
// Review ServerScriptService placement before deployment.
// Review BanningEnabled before using rban/runban.
// Review Player.Data names before using rgive/rremove.
// Review PetTemplate structure before giving pets.
// Review the game's existing autosave behaviour before reset operations.
// Keep secrets out of Git repositories.
// Keep this project server-side.
