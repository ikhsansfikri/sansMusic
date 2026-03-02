const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getAutoplaySongs } = require('./utils/autoplay');
const client = require('./client');
const logger = require('./logger');

const queue = new Map();
const DEFAULT_AUTO_PAUSE_LIMIT_MS = 40 * 60 * 1000;

function stopAutoPauseMonitor(serverQueue) {
    if (serverQueue?.autoPauseTimer) {
        clearInterval(serverQueue.autoPauseTimer);
        serverQueue.autoPauseTimer = null;
    }
}

function startAutoPauseMonitor(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return;

    stopAutoPauseMonitor(serverQueue);
    serverQueue.autoPauseLastTick = Date.now();
    const limitMs = serverQueue.autoPauseLimitMs || DEFAULT_AUTO_PAUSE_LIMIT_MS;
    serverQueue.autoPauseTimer = setInterval(() => {
        const sq = queue.get(guildId);
        if (!sq) return stopAutoPauseMonitor(serverQueue);

        const now = Date.now();
        const delta = Math.max(0, now - (sq.autoPauseLastTick || now));
        sq.autoPauseLastTick = now;

        if (sq.player?.state?.status === AudioPlayerStatus.Playing && !sq.autoPausePending) {
            if (typeof sq.autoPausePlayedMs !== 'number') sq.autoPausePlayedMs = 0;
            sq.autoPausePlayedMs += delta;
            if (sq.autoPausePlayedMs >= limitMs) triggerAutoPause(guildId);
        }
    }, 30_000);
}

async function triggerAutoPause(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.autoPausePending) return;

    serverQueue.autoPausePending = true;
    try { serverQueue.player.pause(); } catch { }

    const limitMinutes = Math.round((serverQueue.autoPauseLimitMs || DEFAULT_AUTO_PAUSE_LIMIT_MS) / 60000);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('autoPauseResume').setLabel('Resume').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('autoPauseStop').setLabel('Stop').setStyle(ButtonStyle.Danger)
    );

    const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('Playback paused')
        .setDescription(`Music paused after ${limitMinutes} minutes. Confirm to continue or stop playback.`)
        .setFooter({ text: serverQueue.textChannel.guild.name, iconURL: serverQueue.textChannel.guild.iconURL() })
        .setTimestamp();

    const prompt = await serverQueue.textChannel.send({ embeds: [embed], components: [row] });
    const collector = prompt.createMessageComponentCollector({ time: 120_000 });

    collector.on('collect', async interaction => {
        if (interaction.user.bot) return;
        if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== serverQueue.voiceChannel.id) {
            return interaction.reply({ content: '❌ Join the voice channel to control playback.', ephemeral: true });
        }

        if (interaction.customId === 'autoPauseResume') {
            serverQueue.autoPausePending = false;
            serverQueue.autoPausePlayedMs = 0;
            serverQueue.autoPauseLastTick = Date.now();
            try { serverQueue.player.unpause(); } catch { }
            startAutoPauseMonitor(guildId);
            return interaction.update({ content: '▶ Resuming playback.', embeds: [], components: [] });
        }

        if (interaction.customId === 'autoPauseStop') {
            serverQueue.songs = [];
            serverQueue.player.stop();
            stopAutoPauseMonitor(serverQueue);
            queue.delete(guildId);
            try { serverQueue.connection.destroy(); } catch { }
            return interaction.update({ content: '⏹ Playback stopped.', embeds: [], components: [] });
        }
    });

    collector.on('end', () => {
        if (!prompt.editable) return;
        prompt.edit({ components: [] }).catch(() => { });
    });
}

async function playSong(guildId, song) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return;

    if (!serverQueue.autoPauseLimitMs) serverQueue.autoPauseLimitMs = DEFAULT_AUTO_PAUSE_LIMIT_MS;

    if (!song || (serverQueue.lastPlayed && !serverQueue.songs)) {
        if (!serverQueue.lastPlayed) return;
        const related = await getAutoplaySongs(serverQueue.lastPlayed.id, 15);
        if (!related.length) return;

        let fresh = related.filter(s => !serverQueue.history.has(s.id));
        if (!fresh.length) serverQueue.history.clear();

        const pick = fresh.sort(() => Math.random() - 0.5).slice(0, 3);
        for (const s of pick) serverQueue.songs.push({ ...s, requester: client.user, isAutoplay: true });

        return playSong(guildId, serverQueue.songs[0]);
    }

    if (serverQueue.streamProcess) {
        try { serverQueue.streamProcess.kill('SIGKILL'); } catch { }
        serverQueue.streamProcess = null;
    }

    console.log(`[PLAY] Playing: ${song.title}`);
    logger.info(`[PLAY] Playing: ${song.title}`);
    const child = require('child_process').spawn('yt-dlp', [
        song.webpage_url,
        '-o', '-',
        '-f', 'bestaudio',
        '--no-playlist',
        '-q'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    serverQueue.streamProcess = child;
    serverQueue.player.play(createAudioResource(child.stdout));

    serverQueue.lastPlayed = song;
    serverQueue.history.add(song.id);
    if (serverQueue.history.size > 100) serverQueue.history.clear();

    const embed = new EmbedBuilder()
        .setColor(song.isAutoplay ? 0x9b59b6 : 0x1db954)
        .setAuthor({
            name: song.isAutoplay ? `${client.user.username} • Autoplay` : client.user.username,
            iconURL: client.user.displayAvatarURL()
        })
        .setTitle(song.title)
        .setURL(song.url)
        .setThumbnail(song.thumbnail || serverQueue.textChannel.guild.iconURL())
        .addFields(
            { name: 'Duration', value: song.duration, inline: true },
            { name: 'Requested by', value: song.isAutoplay ? 'Autoplay' : song.requester.username, inline: true }
        )
        .setFooter({
            text: serverQueue.textChannel.guild.name,
            iconURL: serverQueue.textChannel.guild.iconURL()
        })
        .setTimestamp();

    serverQueue.songStartTime = Date.now();
    serverQueue.currentDurationSec = song.duration_seconds || null;
    serverQueue.textChannel.send({ embeds: [embed] });

    serverQueue.autoPausePending = false;
    serverQueue.autoPausePlayedMs = 0;
    serverQueue.autoPauseLastTick = Date.now();
    startAutoPauseMonitor(guildId);
}

function restartAutoPauseMonitor(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return;
    serverQueue.autoPausePending = false;
    serverQueue.autoPausePlayedMs = 0;
    serverQueue.autoPauseLastTick = Date.now();
    startAutoPauseMonitor(guildId);
}

module.exports = {
    queue,
    playSong,
    stopAutoPauseMonitor,
    restartAutoPauseMonitor,
    DEFAULT_AUTO_PAUSE_LIMIT_MS
};
