import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder
} from 'discord.js';

import axios from 'axios';
import pg from 'pg';
import http from 'http';

const { Pool } = pg;

// ==================================================
// CONFIG
// ==================================================

const FINANCIAL_OPERATIONS_ROLE = '1551601783581843497';
const SUPPORT_ROLE = '1544700169277280368';

const BADGE_ID = '1761374138287057';

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;

// Optional Discord logging channel.
// Leave blank if you don't want Discord log messages yet.
const LOG_CHANNEL_ID =
    process.env.LOG_CHANNEL_ID || '';

// ==================================================
// DATABASE
// ==================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    ssl: {
        rejectUnauthorized: false
    }
});

// ==================================================
// DISCORD CLIENT
// ==================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

// ==================================================
// COLOURS
// ==================================================

const COLORS = {

    GREEN: 0x2ecc71,

    ORANGE: 0xf39c12,

    RED: 0xe74c3c,

    BLUE: 0x3498db,

    GREY: 0x5865F2
};

// ==================================================
// EMBEDS
// ==================================================

function createEmbed(
    title,
    description,
    color
) {

    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
}

// ==================================================
// PROGRESS BAR
// ==================================================

function progressBar(percent) {

    const total = 10;

    const filled = Math.round(
        (percent / 100) * total
    );

    const empty = total - filled;

    return (
        '█'.repeat(filled) +
        '░'.repeat(empty)
    );
}

function progressEmbed(
    title,
    percent,
    message
) {

    let color = COLORS.ORANGE;

    if (percent >= 100) {
        color = COLORS.GREEN;
    }

    if (percent <= 0) {
        color = COLORS.RED;
    }

    return createEmbed(
        `> ${title}`,
        [
            '```text',
            `${progressBar(percent)} ${percent}%`,
            '```',
            '',
            message
        ].join('\n'),
        color
    );
}

// ==================================================
// DATABASE SETUP
// ==================================================

async function setupDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS authorizations (

            id SERIAL PRIMARY KEY,

            roblox_username TEXT NOT NULL,

            roblox_user_id BIGINT UNIQUE NOT NULL,

            discord_user_id TEXT NOT NULL,

            authorized BOOLEAN NOT NULL DEFAULT TRUE,

            authorization_source
                TEXT NOT NULL DEFAULT 'manual',

            authorized_at
                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            authorized_by TEXT NOT NULL,

            rban BOOLEAN NOT NULL DEFAULT FALSE,

            rban_at TIMESTAMPTZ,

            rban_by TEXT
        )
    `);

    await pool.query(`
        ALTER TABLE authorizations
        ADD COLUMN IF NOT EXISTS authorization_source
        TEXT NOT NULL DEFAULT 'manual'
    `);

    await pool.query(`
        ALTER TABLE authorizations
        ADD COLUMN IF NOT EXISTS rban
        BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await pool.query(`
        ALTER TABLE authorizations
        ADD COLUMN IF NOT EXISTS rban_at
        TIMESTAMPTZ
    `);

    await pool.query(`
        ALTER TABLE authorizations
        ADD COLUMN IF NOT EXISTS rban_by
        TEXT
    `);

    // ==================================================
    // HISTORY TABLE
    // ==================================================

    await pool.query(`
        CREATE TABLE IF NOT EXISTS authorization_history (

            id SERIAL PRIMARY KEY,

            roblox_username TEXT NOT NULL,

            roblox_user_id BIGINT NOT NULL,

            action TEXT NOT NULL,

            source TEXT,

            staff_user_id TEXT,

            staff_tag TEXT,

            created_at
                TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    console.log('[DATABASE] Ready');
}

// ==================================================
// HISTORY LOGGER
// ==================================================

async function logAction(
    username,
    userId,
    action,
    source,
    staffId,
    staffTag
) {

    try {

        await pool.query(
            `
            INSERT INTO authorization_history (

                roblox_username,

                roblox_user_id,

                action,

                source,

                staff_user_id,

                staff_tag

            )

            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6
            )
            `,
            [
                username,
                userId,
                action,
                source || null,
                staffId || null,
                staffTag || null
            ]
        );

    } catch (error) {

        console.error(
            '[HISTORY] Failed:',
            error.message
        );
    }
}

// ==================================================
// PERMISSION HELPERS
// ==================================================

function isFinancial(interaction) {

    return interaction.member.roles.cache.has(
        FINANCIAL_OPERATIONS_ROLE
    );
}

function isSupport(interaction) {

    return interaction.member.roles.cache.has(
        SUPPORT_ROLE
    );
}

function canView(interaction) {

    return (
        isFinancial(interaction) ||
        isSupport(interaction)
    );
}

// ==================================================
// ROBLOX USER LOOKUP
// ==================================================

async function getRobloxUser(username) {

    try {

        const response =
            await axios.post(
                'https://users.roblox.com/v1/usernames/users',

                {
                    usernames: [username],

                    excludeBannedUsers: false
                },

                {
                    timeout: 10000
                }
            );

        if (
            !response.data ||
            !response.data.data ||
            response.data.data.length === 0
        ) {

            return null;
        }

        return response.data.data[0];

    } catch (error) {

        console.error(
            '[ROBLOX] Lookup failed:',
            error.message
        );

        return null;
    }
}

// ==================================================
// ROBLOX PROFILE
// ==================================================

async function getRobloxProfile(userId) {

    try {

        const [
            userResponse,
            followersResponse,
            followingResponse,
            avatarResponse
        ] = await Promise.all([

            axios.get(
                `https://users.roblox.com/v1/users/${userId}`,
                {
                    timeout: 10000
                }
            ),

            axios.get(
                `https://friends.roblox.com/v1/users/${userId}/followers/count`,
                {
                    timeout: 10000
                }
            ),

            axios.get(
                `https://friends.roblox.com/v1/users/${userId}/followings/count`,
                {
                    timeout: 10000
                }
            ),

            axios.get(
                `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`,
                {
                    timeout: 10000
                }
            )
        ]);

        const user =
            userResponse.data;

        const followers =
            followersResponse.data.count || 0;

        const following =
            followingResponse.data.count || 0;

        let avatar = null;

        if (
            avatarResponse.data &&
            avatarResponse.data.data &&
            avatarResponse.data.data.length
        ) {

            avatar =
                avatarResponse.data.data[0].imageUrl;
        }

        return {

            id: user.id,

            username: user.name,

            displayName:
                user.displayName,

            description:
                user.description ||
                'No description.',

            created:
                user.created,

            banned:
                user.isBanned,

            followers,

            following,

            avatar
        };

    } catch (error) {

        console.error(
            '[PROFILE] Failed:',
            error.message
        );

        return null;
    }
}

// ==================================================
// DISCORD LOGGING
// ==================================================

async function sendDiscordLog(
    title,
    description,
    color
) {

    if (!LOG_CHANNEL_ID) {
        return;
    }

    try {

        const channel =
            await client.channels.fetch(
                LOG_CHANNEL_ID
            );

        if (!channel) {
            return;
        }

        await channel.send({
            embeds: [
                createEmbed(
                    title,
                    description,
                    color
                )
            ]
        });

    } catch (error) {

        console.error(
            '[DISCORD LOG] Failed:',
            error.message
        );
    }
}

// ==================================================
// COMMANDS
// ==================================================

const commands = [

    // AUTH
    new SlashCommandBuilder()
        .setName('auth')
        .setDescription(
            'Manually authorize a Roblox user'
        )
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription(
                    'Roblox username'
                )
                .setRequired(true)
        ),

    // CHECK
    new SlashCommandBuilder()
        .setName('check')
        .setDescription(
            'Check Roblox authorization'
        )
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription(
                    'Roblox username'
                )
                .setRequired(true)
        ),

    // RBAN
    new SlashCommandBuilder()
        .setName('rban')
        .setDescription(
            'Block a Roblox user from the script'
        )
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription(
                    'Roblox username'
                )
                .setRequired(true)
        ),

    // UNRBAN
    new SlashCommandBuilder()
        .setName('unrban')
        .setDescription(
            'Remove a Roblox rBan'
        )
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription(
                    'Roblox username'
                )
                .setRequired(true)
        ),

    // PROFILE
    new SlashCommandBuilder()
        .setName('profile')
        .setDescription(
            'View Roblox profile'
        )
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription(
                    'Roblox username'
                )
                .setRequired(true)
        ),

    // WHOIS
    new SlashCommandBuilder()
        .setName('whois')
        .setDescription(
            'View Roblox profile and authorization'
        )
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription(
                    'Roblox username'
                )
                .setRequired(true)
        ),

    // HISTORY
    new SlashCommandBuilder()
        .setName('history')
        .setDescription(
            'View authorization history'
        )
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription(
                    'Roblox username'
                )
                .setRequired(true)
        ),

    // SEARCH
    new SlashCommandBuilder()
        .setName('search')
        .setDescription(
            'Search for an authorization record'
        )
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription(
                    'Roblox username'
                )
                .setRequired(true)
        ),

    // STATS
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription(
            'View authorization statistics'
        ),

    // LOGS
    new SlashCommandBuilder()
        .setName('logs')
        .setDescription(
            'View recent authorization actions'
        )

].map(command => command.toJSON());

// ==================================================
// HTTP API
// ==================================================

const server = http.createServer(
    async (req, res) => {

        // ==================================================
        // HEALTH
        // ==================================================

        if (
            req.method === 'GET' &&
            req.url === '/'
        ) {

            res.writeHead(
                200,
                {
                    'Content-Type':
                        'application/json'
                }
            );

            return res.end(
                JSON.stringify({
                    status: 'online',
                    service:
                        'Devil Auth API'
                })
            );
        }

        // ==================================================
        // SCRIPT CHECK
        // ==================================================

        if (
            req.method === 'POST' &&
            req.url === '/check'
        ) {

            const authorization =
                req.headers.authorization;

            if (
                !API_SECRET ||
                authorization !==
                    `Bearer ${API_SECRET}`
            ) {

                res.writeHead(
                    401,
                    {
                        'Content-Type':
                            'application/json'
                    }
                );

                return res.end(
                    JSON.stringify({
                        error:
                            'Unauthorized'
                    })
                );
            }

            let body = '';

            req.on(
                'data',
                chunk => {
                    body += chunk;
                }
            );

            req.on(
                'end',
                async () => {

                    try {

                        const data =
                            JSON.parse(body);

                        const userId =
                            data.robloxUserId;

                        if (!userId) {

                            res.writeHead(
                                400,
                                {
                                    'Content-Type':
                                        'application/json'
                                }
                            );

                            return res.end(
                                JSON.stringify({
                                    error:
                                        'Missing robloxUserId'
                                })
                            );
                        }

                        const result =
                            await pool.query(
                                `
                                SELECT
                                    authorized,
                                    rban
                                FROM authorizations
                                WHERE roblox_user_id = $1
                                LIMIT 1
                                `,
                                [userId]
                            );

                        if (
                            result.rows.length === 0
                        ) {

                            res.writeHead(
                                200,
                                {
                                    'Content-Type':
                                        'application/json'
                                }
                            );

                            return res.end(
                                JSON.stringify({
                                    authorized:
                                        false,

                                    rban:
                                        false
                                })
                            );
                        }

                        const user =
                            result.rows[0];

                        const allowed =
                            user.authorized === true &&
                            user.rban !== true;

                        res.writeHead(
                            200,
                            {
                                'Content-Type':
                                    'application/json'
                            }
                        );

                        return res.end(
                            JSON.stringify({

                                authorized:
                                    allowed,

                                rban:
                                    user.rban === true
                            })
                        );

                    } catch (error) {

                        console.error(
                            '[API CHECK]',
                            error
                        );

                        res.writeHead(
                            500,
                            {
                                'Content-Type':
                                    'application/json'
                            }
                        );

                        return res.end(
                            JSON.stringify({
                                error:
                                    'Internal server error'
                            })
                        );
                    }
                }
            );

            return;
        }

        // ==================================================
        // BADGE AUTHORIZATION
        // ==================================================

        if (
            req.method === 'POST' &&
            req.url === '/badge-authorize'
        ) {

            const authorization =
                req.headers.authorization;

            if (
                !API_SECRET ||
                authorization !==
                    `Bearer ${API_SECRET}`
            ) {

                res.writeHead(
                    401,
                    {
                        'Content-Type':
                            'application/json'
                    }
                );

                return res.end(
                    JSON.stringify({
                        error:
                            'Unauthorized'
                    })
                );
            }

            let body = '';

            req.on(
                'data',
                chunk => {
                    body += chunk;
                }
            );

            req.on(
                'end',
                async () => {

                    try {

                        const data =
                            JSON.parse(body);

                        const userId =
                            data.robloxUserId;

                        const username =
                            data.robloxUsername;

                        if (
                            !userId ||
                            !username
                        ) {

                            res.writeHead(
                                400,
                                {
                                    'Content-Type':
                                        'application/json'
                                }
                            );

                            return res.end(
                                JSON.stringify({
                                    error:
                                        'Missing Roblox user information'
                                })
                            );
                        }

                        const existing =
                            await pool.query(
                                `
                                SELECT rban
                                FROM authorizations
                                WHERE roblox_user_id = $1
                                LIMIT 1
                                `,
                                [userId]
                            );

                        // rBan ALWAYS overrides badge.

                        if (
                            existing.rows.length &&
                            existing.rows[0].rban === true
                        ) {

                            console.log(
                                `[BadgeAuth] ${username} blocked by rBan`
                            );

                            res.writeHead(
                                200,
                                {
                                    'Content-Type':
                                        'application/json'
                                }
                            );

                            return res.end(
                                JSON.stringify({
                                    success:
                                        true,

                                    authorized:
                                        false,

                                    rban:
                                        true
                                })
                            );
                        }

                        await pool.query(
                            `
                            INSERT INTO authorizations (

                                roblox_username,

                                roblox_user_id,

                                discord_user_id,

                                authorized,

                                authorization_source,

                                authorized_at,

                                authorized_by,

                                rban

                            )

                            VALUES (

                                $1,

                                $2,

                                'ROBLOX',

                                TRUE,

                                'badge',

                                NOW(),

                                'Roblox Badge System',

                                FALSE
                            )

                            ON CONFLICT
                            (roblox_user_id)

                            DO UPDATE SET

                                roblox_username =
                                    EXCLUDED.roblox_username,

                                authorized =
                                    TRUE,

                                authorization_source =
                                    'badge',

                                authorized_at =
                                    NOW(),

                                authorized_by =
                                    'Roblox Badge System'
                            `,
                            [
                                username,
                                userId
                            ]
                        );

                        await logAction(
                            username,
                            userId,
                            'BADGE_AUTH',
                            'badge',
                            'ROBLOX',
                            'Roblox Badge System'
                        );

                        res.writeHead(
                            200,
                            {
                                'Content-Type':
                                    'application/json'
                            }
                        );

                        return res.end(
                            JSON.stringify({

                                success:
                                    true,

                                authorized:
                                    true,

                                rban:
                                    false,

                                badgeId:
                                    BADGE_ID
                            })
                        );

                    } catch (error) {

                        console.error(
                            '[BADGE AUTH]',
                            error
                        );

                        res.writeHead(
                            500,
                            {
                                'Content-Type':
                                    'application/json'
                            }
                        );

                        return res.end(
                            JSON.stringify({
                                error:
                                    'Internal server error'
                            })
                        );
                    }
                }
            );

            return;
        }

        // ==================================================
        // 404
        // ==================================================

        res.writeHead(
            404,
            {
                'Content-Type':
                    'application/json'
            }
        );

        return res.end(
            JSON.stringify({
                error:
                    'Not found'
            })
        );
    }
);

// ==================================================
// START SERVER
// ==================================================

server.listen(
    PORT,
    () => {

        console.log(
            `[API] Running on port ${PORT}`
        );

    }
);

// ==================================================
// DISCORD READY
// ==================================================

client.once(
    'ready',
    async () => {

        console.log(
            `[DISCORD] Logged in as ${client.user.tag}`
        );

        try {

            await setupDatabase();

            const rest =
                new REST({
                    version: '10'
                }).setToken(
                    process.env.DISCORD_TOKEN
                );

            await rest.put(
                Routes.applicationCommands(
                    client.user.id
                ),
                {
                    body: commands
                }
            );

            console.log(
                `[DISCORD] Registered ${commands.length} commands`
            );

            console.log(
                `[DISCORD] Badge ID: ${BADGE_ID}`
            );

        } catch (error) {

            console.error(
                '[DISCORD] Startup error:',
                error
            );
        }
    }
);

// ==================================================
// DISCORD COMMAND HANDLER
// ==================================================

client.on(
    'interactionCreate',
    async interaction => {

        if (
            !interaction.isChatInputCommand()
        ) {
            return;
        }

        const command =
            interaction.commandName;

        const username =
            interaction.options.getString(
                'robloxuser'
            );

        // ==================================================
        // AUTH
        // ==================================================

        if (command === 'auth') {

            if (!isFinancial(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/auth`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'AUTHORIZATION',
                        20,
                        '> fetching Roblox user...'
                    )
                ]
            });

            try {

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ User Not Found',
                                `Roblox user **${username}** could not be found.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                await interaction.editReply({
                    embeds: [
                        progressEmbed(
                            'AUTHORIZATION',
                            55,
                            '> resolving account...'
                        )
                    ]
                });

                const existing =
                    await pool.query(
                        `
                        SELECT rban
                        FROM authorizations
                        WHERE roblox_user_id = $1
                        LIMIT 1
                        `,
                        [user.id]
                    );

                if (
                    existing.rows.length &&
                    existing.rows[0].rban === true
                ) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ RBAN BLOCK',
                                `**${user.name}** is rBanned and cannot be authorized.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                await pool.query(
                    `
                    INSERT INTO authorizations (

                        roblox_username,

                        roblox_user_id,

                        discord_user_id,

                        authorized,

                        authorization_source,

                        authorized_at,

                        authorized_by,

                        rban

                    )

                    VALUES (

                        $1,
                        $2,
                        $3,
                        TRUE,
                        'manual',
                        NOW(),
                        $4,
                        FALSE
                    )

                    ON CONFLICT
                    (roblox_user_id)

                    DO UPDATE SET

                        roblox_username =
                            EXCLUDED.roblox_username,

                        discord_user_id =
                            EXCLUDED.discord_user_id,

                        authorized =
                            TRUE,

                        authorization_source =
                            'manual',

                        authorized_at =
                            NOW(),

                        authorized_by =
                            EXCLUDED.authorized_by
                    `,
                    [
                        user.name,
                        user.id,
                        interaction.user.id,
                        interaction.user.tag
                    ]
                );

                await logAction(
                    user.name,
                    user.id,
                    'AUTH',
                    'manual',
                    interaction.user.id,
                    interaction.user.tag
                );

                await sendDiscordLog(
                    '✓ Authorization',
                    `**${user.name}** was authorized by **${interaction.user.tag}**.`,
                    COLORS.GREEN
                );

                return interaction.editReply({
                    embeds: [
                        progressEmbed(
                            'AUTHORIZATION COMPLETE',
                            100,
                            `> ${user.name} is now authorized.\n\n**Roblox ID:** \`${user.id}\`\n**Source:** \`manual\``
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[AUTH]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'An error occurred while authorizing this user.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }

        // ==================================================
        // CHECK
        // ==================================================

        if (command === 'check') {

            if (!canView(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/check`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'USER CHECK',
                        30,
                        '> fetching Roblox user...'
                    )
                ]
            });

            try {

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ User Not Found',
                                `Roblox user **${username}** could not be found.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                const result =
                    await pool.query(
                        `
                        SELECT *
                        FROM authorizations
                        WHERE roblox_user_id = $1
                        LIMIT 1
                        `,
                        [user.id]
                    );

                if (
                    result.rows.length === 0
                ) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ No Record',
                                `**${user.name}** has no authorization record.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                const record =
                    result.rows[0];

                if (record.rban) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '🔴 RBANNED',
                                `**${user.name}** is blocked from using the script.\n\n**Roblox ID:** \`${user.id}\`\n**rBanned by:** ${record.rban_by || 'Unknown'}`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                if (!record.authorized) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ Not Authorized',
                                `**${user.name}** is not currently authorized.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✓ User Authorized',
                            `**${user.name}** is authorized.\n\n` +
                            `**Roblox ID**\n\`${user.id}\`\n\n` +
                            `**Source**\n\`${record.authorization_source}\`\n\n` +
                            `**Authorized By**\n${record.authorized_by}\n\n` +
                            `**Authorized At**\n<t:${Math.floor(new Date(record.authorized_at).getTime() / 1000)}:F>`,
                            COLORS.GREEN
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[CHECK]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'An error occurred while checking this user.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }

        // ==================================================
        // RBAN
        // ==================================================

        if (command === 'rban') {

            if (!isFinancial(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/rban`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'RBAN',
                        20,
                        '> fetching Roblox user...'
                    )
                ]
            });

            try {

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ User Not Found',
                                `Roblox user **${username}** could not be found.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                await interaction.editReply({
                    embeds: [
                        progressEmbed(
                            'RBAN',
                            60,
                            '> blocking script authorization...'
                        )
                    ]
                });

                await pool.query(
                    `
                    INSERT INTO authorizations (

                        roblox_username,

                        roblox_user_id,

                        discord_user_id,

                        authorized,

                        authorization_source,

                        authorized_at,

                        authorized_by,

                        rban,

                        rban_at,

                        rban_by

                    )

                    VALUES (

                        $1,
                        $2,
                        'SYSTEM',
                        FALSE,
                        'rban',
                        NOW(),
                        $3,
                        TRUE,
                        NOW(),
                        $3
                    )

                    ON CONFLICT
                    (roblox_user_id)

                    DO UPDATE SET

                        roblox_username =
                            EXCLUDED.roblox_username,

                        authorized =
                            FALSE,

                        authorization_source =
                            'rban',

                        authorized_at =
                            NOW(),

                        authorized_by =
                            EXCLUDED.authorized_by,

                        rban =
                            TRUE,

                        rban_at =
                            NOW(),

                        rban_by =
                            EXCLUDED.rban_by
                    `,
                    [
                        user.name,
                        user.id,
                        interaction.user.tag
                    ]
                );

                await logAction(
                    user.name,
                    user.id,
                    'RBAN',
                    'rban',
                    interaction.user.id,
                    interaction.user.tag
                );

                await sendDiscordLog(
                    '🔴 rBan',
                    `**${user.name}** was rBanned by **${interaction.user.tag}**.`,
                    COLORS.RED
                );

                return interaction.editReply({
                    embeds: [
                        progressEmbed(
                            'RBAN COMPLETE',
                            100,
                            `> ${user.name} is now blocked from the script.\n\n**Roblox ID:** \`${user.id}\``
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[RBAN]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'An error occurred while rBanning this user.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }

        // ==================================================
        // UNRBAN
        // ==================================================

        if (command === 'unrban') {

            if (!isFinancial(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/unrban`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'UNRBAN',
                        30,
                        '> locating Roblox user...'
                    )
                ]
            });

            try {

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ User Not Found',
                                `Roblox user **${username}** could not be found.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                await pool.query(
                    `
                    UPDATE authorizations

                    SET
                        rban = FALSE,
                        rban_at = NULL,
                        rban_by = NULL,
                        authorized = TRUE,
                        authorized_at = NOW(),
                        authorized_by = $2

                    WHERE roblox_user_id = $1
                    `,
                    [
                        user.id,
                        interaction.user.tag
                    ]
                );

                await logAction(
                    user.name,
                    user.id,
                    'UNRBAN',
                    'unrban',
                    interaction.user.id,
                    interaction.user.tag
                );

                await sendDiscordLog(
                    '✓ rBan Removed',
                    `The rBan on **${user.name}** was removed by **${interaction.user.tag}**.`,
                    COLORS.GREEN
                );

                return interaction.editReply({
                    embeds: [
                        progressEmbed(
                            'UNRBAN COMPLETE',
                            100,
                            `> ${user.name} is no longer rBanned.\n\n**Roblox ID:** \`${user.id}\``
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[UNRBAN]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'An error occurred while removing the rBan.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }

        // ==================================================
        // PROFILE
        // ==================================================

        if (command === 'profile') {

            if (!canView(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/profile`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'ROBLOX PROFILE',
                        50,
                        '> loading Roblox profile...'
                    )
                ]
            });

            try {

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ User Not Found',
                                `Roblox user **${username}** could not be found.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                const profile =
                    await getRobloxProfile(
                        user.id
                    );

                if (!profile) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ Profile Error',
                                'Unable to retrieve the Roblox profile.',
                                COLORS.RED
                            )
                        ]
                    });
                }

                const embed =
                    createEmbed(
                        `👤 ${profile.displayName}`,
                        [
                            `**Username**`,
                            `@${profile.username}`,
                            '',
                            `**Roblox ID**`,
                            `\`${profile.id}\``,
                            '',
                            `**Description**`,
                            profile.description.substring(
                                0,
                                700
                            ),
                            '',
                            `**Followers**`,
                            profile.followers.toLocaleString(),
                            '',
                            `**Following**`,
                            profile.following.toLocaleString(),
                            '',
                            `**Account Created**`,
                            `<t:${Math.floor(new Date(profile.created).getTime() / 1000)}:D>`
                        ].join('\n'),
                        COLORS.BLUE
                    );

                if (profile.avatar) {
                    embed.setThumbnail(
                        profile.avatar
                    );
                }

                return interaction.editReply({
                    embeds: [embed]
                });

            } catch (error) {

                console.error(
                    '[PROFILE]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'Unable to load this profile.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }

        // ==================================================
        // WHOIS
        // ==================================================

        if (command === 'whois') {

            if (!canView(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/whois`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'WHOIS',
                        50,
                        '> gathering account information...'
                    )
                ]
            });

            try {

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ User Not Found',
                                `Roblox user **${username}** could not be found.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                const profile =
                    await getRobloxProfile(
                        user.id
                    );

                const auth =
                    await pool.query(
                        `
                        SELECT *
                        FROM authorizations
                        WHERE roblox_user_id = $1
                        LIMIT 1
                        `,
                        [user.id]
                    );

                let status =
                    '🔴 Not Authorized';

                let source =
                    'None';

                let rban =
                    'No';

                if (auth.rows.length) {

                    const record =
                        auth.rows[0];

                    if (record.rban) {

                        status =
                            '🔴 RBANNED';

                        rban =
                            'Yes';

                    } else if (
                        record.authorized
                    ) {

                        status =
                            '🟢 Authorized';
                    }

                    source =
                        record.authorization_source;
                }

                const embed =
                    createEmbed(
                        `WHOIS — ${user.name}`,
                        [
                            `**Roblox Username**`,
                            user.name,
                            '',
                            `**Display Name**`,
                            user.displayName,
                            '',
                            `**Roblox ID**`,
                            `\`${user.id}\``,
                            '',
                            `**Followers**`,
                            profile
                                ? profile.followers.toLocaleString()
                                : 'Unknown',
                            '',
                            `**Following**`,
                            profile
                                ? profile.following.toLocaleString()
                                : 'Unknown',
                            '',
                            `**Authorization**`,
                            status,
                            '',
                            `**Source**`,
                            source,
                            '',
                            `**rBan**`,
                            rban
                        ].join('\n'),
                        rban === 'Yes'
                            ? COLORS.RED
                            : COLORS.BLUE
                    );

                if (
                    profile &&
                    profile.avatar
                ) {

                    embed.setThumbnail(
                        profile.avatar
                    );
                }

                return interaction.editReply({
                    embeds: [embed]
                });

            } catch (error) {

                console.error(
                    '[WHOIS]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'Unable to retrieve WHOIS information.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }

        // ==================================================
        // SEARCH
        // ==================================================

        if (command === 'search') {

            if (!canView(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/search`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'SEARCH',
                        60,
                        '> searching authorization database...'
                    )
                ]
            });

            try {

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ No Results',
                                `No Roblox account was found for **${username}**.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                const result =
                    await pool.query(
                        `
                        SELECT *
                        FROM authorizations
                        WHERE roblox_user_id = $1
                        LIMIT 1
                        `,
                        [user.id]
                    );

                if (!result.rows.length) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '🔎 Search Result',
                                `**${user.name}** exists on Roblox but has no authorization record.\n\n**Roblox ID:** \`${user.id}\``,
                                COLORS.ORANGE
                            )
                        ]
                    });
                }

                const record =
                    result.rows[0];

                const status =
                    record.rban
                        ? '🔴 RBANNED'
                        : record.authorized
                            ? '🟢 AUTHORIZED'
                            : '🔴 NOT AUTHORIZED';

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '🔎 Search Result',
                            `**Username:** ${record.roblox_username}\n\n` +
                            `**Roblox ID:** \`${record.roblox_user_id}\`\n\n` +
                            `**Status:** ${status}\n\n` +
                            `**Source:** \`${record.authorization_source}\`\n\n` +
                            `**Authorized By:** ${record.authorized_by}`,
                            record.rban
                                ? COLORS.RED
                                : record.authorized
                                    ? COLORS.GREEN
                                    : COLORS.ORANGE
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[SEARCH]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'Search failed.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }

        // ==================================================
        // HISTORY
        // ==================================================

        if (command === 'history') {

            if (!canView(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/history`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'HISTORY',
                        60,
                        '> loading authorization history...'
                    )
                ]
            });

            try {

                const user =
                    await getRobloxUser(
                        username
                    );

                if (!user) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ User Not Found',
                                `Roblox user **${username}** could not be found.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                const result =
                    await pool.query(
                        `
                        SELECT *
                        FROM authorization_history

                        WHERE roblox_user_id = $1

                        ORDER BY created_at DESC

                        LIMIT 10
                        `,
                        [user.id]
                    );

                if (!result.rows.length) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                'History',
                                `No history exists for **${user.name}**.`,
                                COLORS.ORANGE
                            )
                        ]
                    });
                }

                const lines =
                    result.rows.map(
                        (entry, index) => {

                            const timestamp =
                                Math.floor(
                                    new Date(
                                        entry.created_at
                                    ).getTime() / 1000
                                );

                            return (
                                `**${index + 1}. ${entry.action}**\n` +
                                `Staff: ${entry.staff_tag || entry.staff_user_id || 'System'}\n` +
                                `Source: ${entry.source || 'Unknown'}\n` +
                                `<t:${timestamp}:R>`
                            );
                        }
                    );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            `History — ${user.name}`,
                            lines.join('\n\n'),
                            COLORS.BLUE
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[HISTORY]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'Unable to load history.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }

        // ==================================================
        // STATS
        // ==================================================

        if (command === 'stats') {

            if (!canView(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/stats`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'SYSTEM STATS',
                        70,
                        '> calculating authorization statistics...'
                    )
                ]
            });

            try {

                const result =
                    await pool.query(`
                        SELECT

                            COUNT(*)::int AS total,

                            COUNT(*) FILTER (
                                WHERE authorized = TRUE
                            )::int AS authorized,

                            COUNT(*) FILTER (
                                WHERE rban = TRUE
                            )::int AS rbanned,

                            COUNT(*) FILTER (
                                WHERE authorization_source = 'badge'
                            )::int AS badge,

                            COUNT(*) FILTER (
                                WHERE authorization_source = 'manual'
                            )::int AS manual

                        FROM authorizations
                    `);

                const stats =
                    result.rows[0];

                const total =
                    Number(stats.total);

                const authorized =
                    Number(stats.authorized);

                const rbanned =
                    Number(stats.rbanned);

                const badge =
                    Number(stats.badge);

                const manual =
                    Number(stats.manual);

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '📊 Authorization Statistics',
                            [
                                `**Total Records**`,
                                `${total}`,
                                '',
                                `**Authorized**`,
                                `${authorized}`,
                                '',
                                `**rBanned**`,
                                `${rbanned}`,
                                '',
                                `**Badge Authorized**`,
                                `${badge}`,
                                '',
                                `**Manual Authorized**`,
                                `${manual}`,
                                '',
                                '```text',
                                `${progressBar(total > 0 ? Math.round((authorized / total) * 100) : 0)} ${total > 0 ? Math.round((authorized / total) * 100) : 0}% authorized`,
                                '```'
                            ].join('\n'),
                            COLORS.BLUE
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[STATS]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'Unable to calculate statistics.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }

        // ==================================================
        // LOGS
        // ==================================================

        if (command === 'logs') {

            if (!isFinancial(interaction)) {

                return interaction.reply({
                    embeds: [
                        createEmbed(
                            '✕ Access Denied',
                            'You do not have permission to use `/logs`.',
                            COLORS.RED
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    progressEmbed(
                        'SYSTEM LOGS',
                        70,
                        '> loading recent actions...'
                    )
                ]
            });

            try {

                const result =
                    await pool.query(`
                        SELECT *
                        FROM authorization_history

                        ORDER BY created_at DESC

                        LIMIT 10
                    `);

                if (!result.rows.length) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                'System Logs',
                                'No actions have been recorded yet.',
                                COLORS.ORANGE
                            )
                        ]
                    });
                }

                const lines =
                    result.rows.map(
                        (entry, index) => {

                            const timestamp =
                                Math.floor(
                                    new Date(
                                        entry.created_at
                                    ).getTime() / 1000
                                );

                            return (
                                `**${index + 1}. ${entry.action}** — ${entry.roblox_username}\n` +
                                `Staff: ${entry.staff_tag || 'System'} • <t:${timestamp}:R>`
                            );
                        }
                    );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '📋 Recent System Logs',
                            lines.join('\n\n'),
                            COLORS.BLUE
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[LOGS]',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'Unable to load logs.',
                            COLORS.RED
                        )
                    ]
                });
            }
        }
    }
);

// ==================================================
// LOGIN
// ==================================================

client.login(
    process.env.DISCORD_TOKEN
);
