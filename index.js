import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
} from 'discord.js';
import axios from 'axios';

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

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

const FINANCIAL_OPERATIONS_ROLE = '1551601783581843497';
const SUPPORT_ROLE = '1544700169277280368';

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' })
        .setToken(process.env.DISCORD_TOKEN);

    await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
    );

    console.log('Registered /auth and /check');
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const username = interaction.options.getString('robloxuser');

    if (interaction.commandName === 'auth') {
        if (!interaction.member.roles.cache.has(FINANCIAL_OPERATIONS_ROLE)) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                ephemeral: true
            });
        }

        return interaction.reply(
            `Authorization request received for **${username}**.`
        );
    }

    if (interaction.commandName === 'check') {
        const allowed =
            interaction.member.roles.cache.has(FINANCIAL_OPERATIONS_ROLE) ||
            interaction.member.roles.cache.has(SUPPORT_ROLE);

        if (!allowed) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                ephemeral: true
            });
        }

        return interaction.reply(
            `Checking authorization for **${username}**...`
        );
    }
});

client.login(process.env.DISCORD_TOKEN);
