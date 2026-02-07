const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { getAutoplaySongs } = require('./utils/autoplay');
const client = require('./client');
const logger = require('./logger');

const queue = new Map();

async function playSong(guildId, song) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return;

    if (!song) {
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
}

module.exports = { queue, playSong };
