const { Client, GatewayIntentBits, ActivityType, Events } = require('discord.js');
const logger = require('./logger');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once(Events.ClientReady, () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    logger.info(`Logged in as ${client.user.tag}`);
    client.user.setPresence({
        activities: [{ name: "-help | -h", type: ActivityType.Listening }],
        status: 'online'
    });
});

module.exports = client;
