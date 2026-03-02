const { Events } = require('discord.js');
const { queue, stopAutoPauseMonitor } = require('./player');
const client = require('./client');
const logger = require('./logger');

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    queue.forEach(async (serverQueue, guildId) => {
        if (!serverQueue.connection) return;
        const botChannel = serverQueue.voiceChannel;
        if (!botChannel) return;
        const nonBotMembers = botChannel.members.filter(m => !m.user.bot);
        if (nonBotMembers.size === 0) {
            console.log(`[AUTO LEAVE] No users left in voice channel. Leaving...`);
            logger.info(`[AUTO LEAVE] No users left in voice channel. Leaving...`);
            serverQueue.textChannel.send('👋 No users left in the voice channel. Leaving now.');
            serverQueue.player.stop();
            serverQueue.songs = [];
            serverQueue.history.clear();
            stopAutoPauseMonitor(serverQueue);
            try { serverQueue.connection.destroy(); } catch { }
            queue.delete(guildId);
        }
    });
});
