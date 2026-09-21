import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
} from 'discord.js';

import axios from 'axios';
import pg from 'pg';

const { Pool } = pg;

// ================================
// CONFIG
// ================================

const FINANCIAL_OPERATIONS_ROLE = '1551601783581843497';
const SUPPORT_ROLE = '1544700169277280368';

const BADGE_ID = '1761374138287057';

// ================================
// DATABASE
// ================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// ================================
// DISCORD CLIENT
// ================================

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// ================================
// COMMANDS
// ================================

const commands = [
    new SlashCommandBuilder()
        .setName('auth')
        .setDescription('Authorize a Roblox user')
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
        )
].map(command => command.toJSON());

// ================================
// DATABASE SETUP
// ================================

async function setupDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS authorizations (
            id SERIAL PRIMARY KEY,
            roblox_username TEXT NOT NULL,
            roblox_user_id BIGINT UNIQUE NOT NULL,
            discord_user_id TEXT NOT NULL,
            authorized BOOLEAN NOT NULL DEFAULT TRUE,
            authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            authorized_by TEXT NOT NULL
        )
    `);

    console.log('Database ready');
}

// ================================
// ROBLOX LOOKUP
// ================================

async function getRobloxUser(username) {
    const response = await axios.post(
        'https://users.roblox.com/v1/usernames/users',
        {
            usernames: [username],
            excludeBannedUsers: false
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
}

// ================================
// BOT READY
// ================================

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    try {
        await setupDatabase();

        const rest = new REST({ version: '10' })
            .setToken(process.env.DISCORD_TOKEN);

        await rest.put(
            Routes.applicationCommands(client.user.id),
            {
                body: commands
            }
        );

        console.log('Registered /auth and /check');
        console.log(`Badge ID: ${BADGE_ID}`);
    } catch (error) {
        console.error('Startup error:', error);
    }
});

// ================================
// COMMAND HANDLER
// ================================

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const username = interaction.options.getString('robloxuser');

    // ============================
    // AUTH
    // ============================

    if (interaction.commandName === 'auth') {

        if (
            !interaction.member.roles.cache.has(
                FINANCIAL_OPERATIONS_ROLE
            )
        ) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                ephemeral: true
            });
        }

        await interaction.deferReply();

        try {
            const robloxUser = await getRobloxUser(username);

            if (!robloxUser) {
                return interaction.editReply(
                    `❌ Roblox user **${username}** could not be found.`
                );
            }

            await pool.query(
                `
                INSERT INTO authorizations (
                    roblox_username,
                    roblox_user_id,
                    discord_user_id,
                    authorized,
                    authorized_at,
                    authorized_by
                )
                VALUES ($1, $2, $3, TRUE, NOW(), $4)
                ON CONFLICT (roblox_user_id)
                DO UPDATE SET
                    roblox_username = EXCLUDED.roblox_username,
                    discord_user_id = EXCLUDED.discord_user_id,
                    authorized = TRUE,
                    authorized_at = NOW(),
                    authorized_by = EXCLUDED.authorized_by
                `,
                [
                    robloxUser.name,
                    robloxUser.id,
                    interaction.user.id,
                    interaction.user.tag
                ]
            );

            return interaction.editReply(
                `✅ **${robloxUser.name}** has been authorized.\n\n` +
                `Roblox ID: \`${robloxUser.id}\`\n` +
                `Badge: \`${BADGE_ID}\``
            );

        } catch (error) {
            console.error('Auth error:', error);

            return interaction.editReply(
                '❌ An error occurred while authorizing this user.'
            );
        }
    }

    // ============================
    // CHECK
    // ============================

    if (interaction.commandName === 'check') {

        const allowed =
            interaction.member.roles.cache.has(
                FINANCIAL_OPERATIONS_ROLE
            ) ||
            interaction.member.roles.cache.has(
                SUPPORT_ROLE
            );

        if (!allowed) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                ephemeral: true
            });
        }

        await interaction.deferReply();

        try {
            const robloxUser = await getRobloxUser(username);

            if (!robloxUser) {
                return interaction.editReply(
                    `❌ Roblox user **${username}** could not be found.`
                );
            }

            const result = await pool.query(
                `
                SELECT *
                FROM authorizations
                WHERE roblox_user_id = $1
                LIMIT 1
                `,
                [robloxUser.id]
            );

            if (result.rows.length === 0) {
                return interaction.editReply(
                    `❌ **${robloxUser.name}** is **not authorized**.`
                );
            }

            const user = result.rows[0];

            if (!user.authorized) {
                return interaction.editReply(
                    `❌ **${robloxUser.name}** is **not authorized**.`
                );
            }

            return interaction.editReply(
                `✅ **${robloxUser.name}** is **authorized**.\n\n` +
                `Roblox ID: \`${robloxUser.id}\`\n` +
                `Authorized: <t:${Math.floor(
                    new Date(user.authorized_at).getTime() / 1000
                )}:F>`
            );

        } catch (error) {
            console.error('Check error:', error);

            return interaction.editReply(
                '❌ An error occurred while checking this user.'
            );
        }
    }
});

// ================================
// LOGIN
// ================================

client.login(process.env.DISCORD_TOKEN);
