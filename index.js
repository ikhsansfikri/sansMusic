require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActivityType } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus
} = require('@discordjs/voice');
const { spawn } = require('child_process');

// ===== CONFIG =====
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '.';
const YT_DLP_COMMAND = 'yt-dlp';

// ===== CLIENT =====
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ===== QUEUE =====
const queue = new Map();

// ===== LOG UTILITY =====
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

// ===== SEARCH (YTM → YT FALLBACK) =====
async function getSongInfo(query) {
    log(`Searching song: "${query}"`);
    let result = await ytSearch(query, 'ytsearchmusic');
    if (result) {
        log(`Found on YouTube Music: "${result.title}"`);
        return result;
    }
    result = await ytSearch(query, 'ytsearch');
    if (result) log(`Found on YouTube: "${result.title}"`);
    else log(`Song not found: "${query}"`);
    return result;
}

function ytSearch(query, mode) {
    return new Promise(resolve => {
        const p = spawn(YT_DLP_COMMAND, [
            '--dump-json',
            '--default-search', mode,
            '--no-playlist',
            '--no-warnings',
            query
        ]);

        let data = '';
        p.stdout.on('data', c => data += c);

        p.on('close', () => {
            try {
                const info = JSON.parse(data);
                const r = info.entries ? info.entries[0] : info;
                resolve({
                    title: r.title,
                    id: r.id,
                    url: r.webpage_url,
                    webpage_url: r.webpage_url,
                    duration: r.duration_string || 'Live',
                    thumbnail: r.thumbnail
                });
            } catch (err) {
                log(`Error parsing search result for "${query}": ${err}`);
                resolve(null);
            }
        });
    });
}

// ===== AUTOPLAY RECOMMENDATION =====
async function getAutoplaySongs(videoId, limit = 12) {
    log(`Fetching autoplay recommendations for videoId: ${videoId}`);
    const p = spawn(YT_DLP_COMMAND, [
        '--dump-json',
        '--flat-playlist',
        '--playlist-end', String(limit + 1),
        '--no-warnings',
        `https://music.youtube.com/watch?v=${videoId}&list=RD${videoId}`
    ]);

    let data = '';
    p.stdout.on('data', c => data += c);

    return new Promise((resolve) => {
        p.on('close', async () => {
            try {
                const lines = data.trim().split('\n');
                const songs = [];

                for (let i = 1; i < lines.length; i++) {
                    const r = JSON.parse(lines[i]);
                    const info = await getSongInfo(`https://music.youtube.com/watch?v=${r.id}`);
                    if (info) songs.push(info);
                }

                log(`Fetched ${songs.length} autoplay songs`);
                resolve(songs);
            } catch (err) {
                log(`Error fetching autoplay songs: ${err}`);
                resolve([]);
            }
        });
    });
}

// ===== PLAY SONG =====
async function playSong(guildId, song) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return;

    if (!song) {
        if (!serverQueue.lastPlayed) return;

        log(`Autoplay triggered for guild ${guildId}`);
        const related = await getAutoplaySongs(serverQueue.lastPlayed.id, 15);
        if (!related.length) {
            log(`No autoplay songs found for "${serverQueue.lastPlayed.title}"`);
            return;
        }

        let fresh = related.filter(s => !serverQueue.history.has(s.id));
        if (!fresh.length) {
            serverQueue.history.clear();
            fresh = related;
        }

        const pick = fresh.sort(() => Math.random() - 0.5).slice(0, 3);
        log(`Adding ${pick.length} autoplay songs to queue`);
        for (const s of pick) {
            serverQueue.songs.push({
                ...s,
                requester: client.user,
                isAutoplay: true
            });
        }

        return playSong(guildId, serverQueue.songs[0]);
    }

    if (serverQueue.streamProcess) {
        try { serverQueue.streamProcess.kill('SIGKILL'); } catch { }
        serverQueue.streamProcess = null;
    }

    log(`Playing song "${song.title}" in guild ${guildId}`);
    const child = spawn(YT_DLP_COMMAND, [
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
            name: song.isAutoplay ? 'YouTube Music • Autoplay' : 'YouTube Music',
            iconURL: song.requester.displayAvatarURL?.()
        })
        .setTitle(song.title)
        .setURL(song.url)
        .setThumbnail(song.thumbnail || serverQueue.textChannel.guild.iconURL())
        .addFields(
            { name: 'Duration', value: song.duration, inline: true },
            {
                name: 'Requested by',
                value: song.isAutoplay ? 'Autoplay' : song.requester.username,
                inline: true
            }
        )
        .setFooter({
            text: serverQueue.textChannel.guild.name,
            iconURL: serverQueue.textChannel.guild.iconURL()
        })
        .setTimestamp();

    serverQueue.textChannel.send({ embeds: [embed] });
}

// ===== READY =====
client.once(Events.ClientReady, () => {
    log(`Logged in as ${client.user.tag}`);
    client.user.setPresence({
        activities: [{ name: '.play | .help', type: ActivityType.Listening }],
        status: 'online'
    });
});

// ===== COMMANDS =====
client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const guildId = message.guild.id;

    if (cmd === 'play') {
        if (!args.length) return message.reply('❌ Masukkan judul lagu');
        if (!message.member.voice.channel) return message.reply('❌ Masuk voice dulu');

        const info = await getSongInfo(args.join(' '));
        if (!info) return message.reply('❌ Lagu tidak ditemukan');

        const song = { ...info, requester: message.author, isAutoplay: false };
        let serverQueue = queue.get(guildId);

        if (!serverQueue) {
            log(`Creating new queue for guild ${guildId}`);
            const player = createAudioPlayer();
            serverQueue = {
                textChannel: message.channel,
                voiceChannel: message.member.voice.channel,
                connection: null,
                player,
                songs: [],
                lastPlayed: null,
                streamProcess: null,
                history: new Set()
            };
            queue.set(guildId, serverQueue);
            serverQueue.songs.push(song);

            const connection = joinVoiceChannel({
                channelId: serverQueue.voiceChannel.id,
                guildId,
                adapterCreator: message.guild.voiceAdapterCreator
            });
            serverQueue.connection = connection;
            connection.subscribe(player);

            player.on(AudioPlayerStatus.Idle, () => {
                log(`Song ended in guild ${guildId}`);
                serverQueue.songs.shift();
                playSong(guildId, serverQueue.songs[0]);
            });

            playSong(guildId, serverQueue.songs[0]);
        } else {
            serverQueue.songs.push(song);
            log(`Added "${song.title}" to queue in guild ${guildId}`);
            message.reply(`✅ Ditambahkan ke queue: **${song.title}**`);
        }
    }

    if (cmd === 'skip') {
        const serverQueue = queue.get(guildId);
        if (serverQueue) {
            log(`Song skipped in guild ${guildId}`);
            serverQueue.player.stop();
        }
    }

    if (cmd === 'stop') {
        const serverQueue = queue.get(guildId);
        if (!serverQueue) return;
        log(`Stopping music and clearing queue in guild ${guildId}`);
        serverQueue.songs = [];
        serverQueue.player.stop();
    }
});

// ===== LOGIN =====
client.login(TOKEN);
