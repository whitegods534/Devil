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
// DISCORD CLIENT
// ==================================================

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// ==================================================
// EMBEDS
// ==================================================

function infoEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(`> ${title}`)
        .setDescription(description)
        .setTimestamp();
}

function successEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(`✓ ${title}`)
        .setDescription(description)
        .setTimestamp();
}

function errorEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(`✕ ${title}`)
        .setDescription(description)
        .setTimestamp();
}

// ==================================================
// COMMANDS
// ==================================================

const commands = [

    new SlashCommandBuilder()
        .setName('auth')
        .setDescription('Manually authorize a Roblox user')
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription('Roblox username')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('check')
        .setDescription('Check a Roblox user')
        .addStringOption(option =>
            option
                .setName('robloxuser')
                .setDescription('Roblox username')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Remove a Roblox authorization')
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
            authorized_by TEXT NOT NULL
        )
    `);

    await pool.query(`
        ALTER TABLE authorizations
        ADD COLUMN IF NOT EXISTS authorization_source
        TEXT NOT NULL DEFAULT 'manual'
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
            '[ROBLOX] User lookup failed:',
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
        // HEALTH CHECK
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
        // ROBLOX AUTHORIZATION CHECK
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

            req.on('data', chunk => {
                body += chunk;
            });

            req.on('end', async () => {

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
                            SELECT authorized
                            FROM authorizations
                            WHERE roblox_user_id = $1
                            LIMIT 1
                            `,
                            [robloxUserId]
                        );

                    const authorized =
                        result.rows.length > 0 &&
                        result.rows[0].authorized === true;

                    res.writeHead(200, {
                        'Content-Type':
                            'application/json'
                    });

                    return res.end(
                        JSON.stringify({
                            authorized
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
            });

            return;
        }

        // ==================================================
        // BADGE AUTO-AUTHORIZATION
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

                console.warn(
                    '[BadgeAuth] Unauthorized request'
                );

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

            req.on('data', chunk => {
                body += chunk;
            });

            req.on('end', async () => {

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

                    await pool.query(
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

                        VALUES (
                            $1,
                            $2,
                            'ROBLOX',
                            TRUE,
                            'badge',
                            NOW(),
                            'Roblox Badge System'
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
                        `[BadgeAuth] Authorized ${robloxUsername} ` +
                        `(${robloxUserId}) using badge ${BADGE_ID}`
                    );

                    res.writeHead(200, {
                        'Content-Type':
                            'application/json'
                    });

                    return res.end(
                        JSON.stringify({
                            success: true,
                            authorized: true,
                            badgeId: BADGE_ID
                        })
                    );

                } catch (error) {

                    console.error(
                        '[BadgeAuth] Database error:',
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
            });

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
// START SERVER
// ==================================================

server.listen(PORT, () => {

    console.log(
        `[API] Running on port ${PORT}`
    );

});

// ==================================================
// DISCORD READY
// ==================================================

client.once('ready', async () => {

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
});

// ==================================================
// DISCORD COMMAND HANDLER
// ==================================================

client.on(
    'interactionCreate',
    async interaction => {

        if (!interaction.isChatInputCommand()) {
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
                        errorEmbed(
                            'Access Denied',
                            'You do not have permission to use `/auth`.'
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    infoEmbed(
                        'AUTHORIZATION',
                        '```text\n' +
                        '> fetching Roblox user...\n' +
                        '> resolving account...\n' +
                        '> checking authorization system...\n' +
                        '> processing request...\n' +
                        '```'
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
                            errorEmbed(
                                'User Not Found',
                                `Roblox user **${username}** could not be found.`
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
                        authorized_by
                    )

                    VALUES (
                        $1,
                        $2,
                        $3,
                        TRUE,
                        'manual',
                        NOW(),
                        $4
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
                        successEmbed(
                            'Authorization Complete',
                            `**${robloxUser.name}** has been manually authorized.\n\n` +
                            `**Roblox ID**\n\`${robloxUser.id}\`\n\n` +
                            `**Source**\n\`manual\``
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
                        errorEmbed(
                            'System Error',
                            'An error occurred while authorizing this user.'
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
                        errorEmbed(
                            'Access Denied',
                            'You do not have permission to use `/check`.'
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    infoEmbed(
                        'USER CHECK',
                        '```text\n' +
                        '> fetching Roblox user...\n' +
                        '> resolving account...\n' +
                        '> querying authorization database...\n' +
                        '> preparing response...\n' +
                        '```'
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
                            errorEmbed(
                                'User Not Found',
                                `Roblox user **${username}** could not be found.`
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
                        [robloxUser.id]
                    );

                const authorized =
                    result.rows.length > 0 &&
                    result.rows[0].authorized === true;

                if (!authorized) {

                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                'Not Authorized',
                                `**${robloxUser.name}** is currently **not authorized**.\n\n` +
                                `**Roblox ID**\n\`${robloxUser.id}\``
                            )
                        ]
                    });
                }

                const user =
                    result.rows[0];

                return interaction.editReply({
                    embeds: [
                        successEmbed(
                            'User Authorized',
                            `**${robloxUser.name}** is currently **authorized**.\n\n` +
                            `**Roblox ID**\n\`${robloxUser.id}\`\n\n` +
                            `**Source**\n\`${user.authorization_source}\`\n\n` +
                            `**Authorized**\n<t:${Math.floor(
                                new Date(
                                    user.authorized_at
                                ).getTime() / 1000
                            )}:F>`
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
                        errorEmbed(
                            'System Error',
                            'An error occurred while checking this user.'
                        )
                    ]
                });
            }
        }

        // ==================================================
        // /REMOVE
        // ==================================================

        if (
            interaction.commandName === 'remove'
        ) {

            if (
                !interaction.member.roles.cache.has(
                    FINANCIAL_OPERATIONS_ROLE
                )
            ) {

                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            'Access Denied',
                            'You do not have permission to use `/remove`.'
                        )
                    ],
                    ephemeral: true
                });
            }

            await interaction.reply({
                embeds: [
                    infoEmbed(
                        'REMOVE AUTHORIZATION',
                        '```text\n' +
                        '> fetching Roblox user...\n' +
                        '> locating authorization...\n' +
                        '> removing access...\n' +
                        '```'
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
                            errorEmbed(
                                'User Not Found',
                                `Roblox user **${username}** could not be found.`
                            )
                        ]
                    });
                }

                const result =
                    await pool.query(
                        `
                        UPDATE authorizations
                        SET
                            authorized = FALSE,
                            authorized_at = NOW(),
                            authorized_by = $2
                        WHERE roblox_user_id = $1
                        RETURNING *
                        `,
                        [
                            robloxUser.id,
                            interaction.user.tag
                        ]
                    );

                if (result.rows.length === 0) {

                    return interaction.editReply({
                        embeds: [
                            errorEmbed(
                                'No Authorization',
                                `**${robloxUser.name}** does not have an authorization record.`
                            )
                        ]
                    });
                }

                return interaction.editReply({
                    embeds: [
                        successEmbed(
                            'Authorization Removed',
                            `Authorization for **${robloxUser.name}** has been removed.\n\n` +
                            `**Roblox ID**\n\`${robloxUser.id}\``
                        )
                    ]
                });

            } catch (error) {

                console.error(
                    '[REMOVE] Error:',
                    error
                );

                return interaction.editReply({
                    embeds: [
                        errorEmbed(
                            'System Error',
                            'An error occurred while removing authorization.'
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
