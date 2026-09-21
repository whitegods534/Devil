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
// DISCORD
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
// PROGRESS
// ==================================================

function progressBar(percent) {

    const total = 10;

    const filled =
        Math.round(
            (percent / 100) * total
        );

    const empty =
        total - filled;

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
// COMMANDS
// ==================================================

const commands = [

    // /auth
    new SlashCommandBuilder()
        .setName('auth')
        .setDescription('Manually authorize a Roblox user')
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription('Roblox username')
                .setRequired(true)
        ),

    // /check
    new SlashCommandBuilder()
        .setName('check')
        .setDescription('Check a Roblox user')
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription('Roblox username')
                .setRequired(true)
        ),

    // /rban
    new SlashCommandBuilder()
        .setName('rban')
        .setDescription('Block a Roblox user from using the script')
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription('Roblox username')
                .setRequired(true)
        ),

    // /profile
    new SlashCommandBuilder()
        .setName('profile')
        .setDescription('View a Roblox profile')
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription('Roblox username')
                .setRequired(true)
        )

].map(command => command.toJSON());

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
            authorization_source TEXT NOT NULL DEFAULT 'manual',
            authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

    console.log('[DATABASE] Ready');
}

// ==================================================
// ROBLOX USER LOOKUP
// ==================================================

async function getRobloxUser(username) {

    try {

        const response = await axios.post(
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
            followersResponse.data.count ?? 0;

        const following =
            followingResponse.data.count ?? 0;

        let avatar = null;

        if (
            avatarResponse.data &&
            avatarResponse.data.data &&
            avatarResponse.data.data.length > 0
        ) {

            avatar =
                avatarResponse.data.data[0].imageUrl;
        }

        return {
            id: user.id,
            username: user.name,
            displayName: user.displayName,
            description:
                user.description ||
                'No description.',
            created: user.created,
            banned: user.isBanned,
            followers,
            following,
            avatar
        };

    } catch (error) {

        console.error(
            '[ROBLOX] Profile error:',
            error.message
        );

        return null;
    }
}

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

            res.writeHead(200, {
                'Content-Type':
                    'application/json'
            });

            return res.end(
                JSON.stringify({
                    status: 'online',
                    service: 'Devil Auth API'
                })
            );
        }

        // ==================================================
        // SCRIPT AUTH CHECK
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

                res.writeHead(401, {
                    'Content-Type':
                        'application/json'
                });

                return res.end(
                    JSON.stringify({
                        error: 'Unauthorized'
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

                        const robloxUserId =
                            data.robloxUserId;

                        if (!robloxUserId) {

                            res.writeHead(400, {
                                'Content-Type':
                                    'application/json'
                            });

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
                                [robloxUserId]
                            );

                        if (
                            result.rows.length === 0
                        ) {

                            res.writeHead(200, {
                                'Content-Type':
                                    'application/json'
                            });

                            return res.end(
                                JSON.stringify({
                                    authorized: false,
                                    rban: false
                                })
                            );
                        }

                        const user =
                            result.rows[0];

                        const allowed =
                            user.authorized === true &&
                            user.rban !== true;

                        res.writeHead(200, {
                            'Content-Type':
                                'application/json'
                        });

                        return res.end(
                            JSON.stringify({
                                authorized: allowed,
                                rban:
                                    user.rban === true
                            })
                        );

                    } catch (error) {

                        console.error(
                            '[API] Check error:',
                            error
                        );

                        res.writeHead(500, {
                            'Content-Type':
                                'application/json'
                        });

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
        // BADGE AUTO AUTH
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

                res.writeHead(401, {
                    'Content-Type':
                        'application/json'
                });

                return res.end(
                    JSON.stringify({
                        error: 'Unauthorized'
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

                        const robloxUserId =
                            data.robloxUserId;

                        const robloxUsername =
                            data.robloxUsername;

                        if (
                            !robloxUserId ||
                            !robloxUsername
                        ) {

                            res.writeHead(400, {
                                'Content-Type':
                                    'application/json'
                            });

                            return res.end(
                                JSON.stringify({
                                    error:
                                        'Missing Roblox user information'
                                })
                            );
                        }

                        // Check rban BEFORE
                        // authorizing from badge.

                        const existing =
                            await pool.query(
                                `
                                SELECT rban
                                FROM authorizations
                                WHERE roblox_user_id = $1
                                LIMIT 1
                                `,
                                [robloxUserId]
                            );

                        if (
                            existing.rows.length > 0 &&
                            existing.rows[0].rban === true
                        ) {

                            console.log(
                                `[BadgeAuth] ${robloxUsername} is RBANNED`
                            );

                            res.writeHead(200, {
                                'Content-Type':
                                    'application/json'
                            });

                            return res.end(
                                JSON.stringify({
                                    success: true,
                                    authorized: false,
                                    rban: true
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

                            ON CONFLICT (roblox_user_id)
                            DO UPDATE SET

                                roblox_username =
                                    EXCLUDED.roblox_username,

                                authorized = TRUE,

                                authorization_source =
                                    'badge',

                                authorized_at =
                                    NOW(),

                                authorized_by =
                                    'Roblox Badge System'
                            `,
                            [
                                robloxUsername,
                                robloxUserId
                            ]
                        );

                        console.log(
                            `[BadgeAuth] Authorized ${robloxUsername}`
                        );

                        res.writeHead(200, {
                            'Content-Type':
                                'application/json'
                        });

                        return res.end(
                            JSON.stringify({
                                success: true,
                                authorized: true,
                                rban: false,
                                badgeId: BADGE_ID
                            })
                        );

                    } catch (error) {

                        console.error(
                            '[BadgeAuth] Error:',
                            error
                        );

                        res.writeHead(500, {
                            'Content-Type':
                                'application/json'
                        });

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

        res.writeHead(404, {
            'Content-Type':
                'application/json'
        });

        return res.end(
            JSON.stringify({
                error: 'Not found'
            })
        );
    }
);

// ==================================================
// SERVER
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
                '[DISCORD] Commands registered'
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
// DISCORD COMMANDS
// ==================================================

client.on(
    'interactionCreate',
    async interaction => {

        if (
            !interaction.isChatInputCommand()
        ) {
            return;
        }

        const username =
            interaction.options.getString(
                'robloxuser'
            );

        // ==================================================
        // /AUTH
        // ==================================================

        if (
            interaction.commandName === 'auth'
        ) {

            if (
                !interaction.member.roles.cache.has(
                    FINANCIAL_OPERATIONS_ROLE
                )
            ) {

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
                        25,
                        '> fetching Roblox user...'
                    )
                ]
            });

            try {

                const robloxUser =
                    await getRobloxUser(
                        username
                    );

                if (!robloxUser) {

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
                            60,
                            '> resolving Roblox account...'
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
                        [robloxUser.id]
                    );

                if (
                    existing.rows.length > 0 &&
                    existing.rows[0].rban === true
                ) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ Authorization Blocked',
                                `**${robloxUser.name}** is currently **rBanned**.\n\nRemove the rBan before authorizing this user.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                await interaction.editReply({
                    embeds: [
                        progressEmbed(
                            'AUTHORIZATION',
                            85,
                            '> updating authorization database...'
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

                    ON CONFLICT (roblox_user_id)
                    DO UPDATE SET

                        roblox_username =
                            EXCLUDED.roblox_username,

                        discord_user_id =
                            EXCLUDED.discord_user_id,

                        authorized = TRUE,

                        authorization_source =
                            'manual',

                        authorized_at =
                            NOW(),

                        authorized_by =
                            EXCLUDED.authorized_by
                    `,
                    [
                        robloxUser.name,
                        robloxUser.id,
                        interaction.user.id,
                        interaction.user.tag
                    ]
                );

                return interaction.editReply({
                    embeds: [
                        progressEmbed(
                            'AUTHORIZATION COMPLETE',
                            100,
                            `> ${robloxUser.name} is now authorized.\n\n**Roblox ID:** \`${robloxUser.id}\`\n**Source:** \`manual\``
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[AUTH] Error:',
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
        // /CHECK
        // ==================================================

        if (
            interaction.commandName === 'check'
        ) {

            const allowed =
                interaction.member.roles.cache.has(
                    FINANCIAL_OPERATIONS_ROLE
                ) ||
                interaction.member.roles.cache.has(
                    SUPPORT_ROLE
                );

            if (!allowed) {

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

                const robloxUser =
                    await getRobloxUser(
                        username
                    );

                if (!robloxUser) {

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
                            'USER CHECK',
                            70,
                            '> checking authorization database...'
                        )
                    ]
                });

                const result =
                    await pool.query(
                        `
                        SELECT *
                        FROM authorizations
                        WHERE roblox_user_id = $1
                        LIMIT 1
                        `,
                        [robloxUser.id]
                    );

                if (
                    result.rows.length === 0
                ) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ Not Authorized',
                                `**${robloxUser.name}** has no authorization record.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                const user =
                    result.rows[0];

                if (
                    user.rban === true
                ) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ rBANNED',
                                `**${robloxUser.name}** is rBanned and cannot use the script.\n\n**Roblox ID:** \`${robloxUser.id}\`\n**rBanned by:** ${user.rban_by || 'Unknown'}`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                if (
                    user.authorized !== true
                ) {

                    return interaction.editReply({
                        embeds: [
                            createEmbed(
                                '✕ Not Authorized',
                                `**${robloxUser.name}** is currently not authorized.`,
                                COLORS.RED
                            )
                        ]
                    });
                }

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✓ User Authorized',
                            `**${robloxUser.name}** is currently **authorized**.\n\n` +
                            `**Roblox ID**\n\`${robloxUser.id}\`\n\n` +
                            `**Source**\n\`${user.authorization_source}\`\n\n` +
                            `**Authorized**\n<t:${Math.floor(
                                new Date(
                                    user.authorized_at
                                ).getTime() / 1000
                            )}:F>`,
                            COLORS.GREEN
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[CHECK] Error:',
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
        // /RBAN
        // ==================================================

        if (
            interaction.commandName === 'rban'
        ) {

            if (
                !interaction.member.roles.cache.has(
                    FINANCIAL_OPERATIONS_ROLE
                )
            ) {

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
                        25,
                        '> fetching Roblox user...'
                    )
                ]
            });

            try {

                const robloxUser =
                    await getRobloxUser(
                        username
                    );

                if (!robloxUser) {

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
                            55,
                            '> locating authorization record...'
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

                    ON CONFLICT (roblox_user_id)
                    DO UPDATE SET

                        roblox_username =
                            EXCLUDED.roblox_username,

                        authorized = FALSE,

                        authorization_source =
                            'rban',

                        authorized_at =
                            NOW(),

                        authorized_by =
                            EXCLUDED.authorized_by,

                        rban = TRUE,

                        rban_at =
                            NOW(),

                        rban_by =
                            EXCLUDED.rban_by
                    `,
                    [
                        robloxUser.name,
                        robloxUser.id,
                        interaction.user.tag
                    ]
                );

                await interaction.editReply({
                    embeds: [
                        progressEmbed(
                            'RBAN',
                            85,
                            '> blocking script access...'
                        )
                    ]
                });

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✓ RBAN COMPLETE',
                            `**${robloxUser.name}** has been **rBanned**.\n\n` +
                            `**Roblox ID:** \`${robloxUser.id}\`\n` +
                            `**Status:** 🔴 Blocked\n` +
                            `**rBanned by:** ${interaction.user.tag}`,
                            COLORS.RED
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[RBAN] Error:',
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
        // /PROFILE
        // ==================================================

        if (
            interaction.commandName === 'profile'
        ) {

            const allowed =
                interaction.member.roles.cache.has(
                    FINANCIAL_OPERATIONS_ROLE
                ) ||
                interaction.member.roles.cache.has(
                    SUPPORT_ROLE
                );

            if (!allowed) {

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
                        40,
                        '> fetching Roblox profile...'
                    )
                ]
            });

            try {

                const robloxUser =
                    await getRobloxUser(
                        username
                    );

                if (!robloxUser) {

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
                            'ROBLOX PROFILE',
                            75,
                            '> loading avatar and account information...'
                        )
                    ]
                });

                const profile =
                    await getRobloxProfile(
                        robloxUser.id
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
                                500
                            ),
                            '',
                            `**Followers**`,
                            `${profile.followers.toLocaleString()}`,
                            '',
                            `**Following**`,
                            `${profile.following.toLocaleString()}`,
                            '',
                            `**Account Created**`,
                            `<t:${Math.floor(
                                new Date(
                                    profile.created
                                ).getTime() / 1000
                            )}:D>`
                        ].join('\n'),
                        COLORS.GREEN
                    );

                if (profile.avatar) {
                    embed.setThumbnail(
                        profile.avatar
                    );
                }

                embed.addFields({
                    name: 'Account Status',
                    value:
                        profile.banned
                            ? '🔴 Banned'
                            : '🟢 Active',
                    inline: true
                });

                return interaction.editReply({
                    embeds: [embed]
                });

            } catch (error) {

                console.error(
                    '[PROFILE] Error:',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        createEmbed(
                            '✕ System Error',
                            'An error occurred while loading the Roblox profile.',
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
