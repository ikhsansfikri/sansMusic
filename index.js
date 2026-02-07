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

// ===== SEARCH (YTM → YT FALLBACK) =====
async function getSongInfo(query) {
    console.log(`[SEARCH] Searching for: ${query}`);
    let result = await ytSearch(query, 'ytsearchmusic');
    if (result) return result;
    return await ytSearch(query, 'ytsearch');
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
                console.log(`[SEARCH] Found: ${r.title}`);

                resolve({
                    title: r.title,
                    id: r.id,
                    url: r.webpage_url,
                    webpage_url: r.webpage_url,
                    duration: r.duration_string || 'Live',
                    thumbnail: r.thumbnail
                });
            } catch (err) {
                console.log(`[SEARCH] Failed to parse: ${query}`);
                resolve(null);
            }
        });
    });
}

// ===== AUTOPLAY RECOMMENDATION =====
async function getAutoplaySongs(videoId, limit = 12) {
    console.log(`[AUTOPLAY] Fetching autoplay for video: ${videoId}`);
    const p = spawn(YT_DLP_COMMAND, [
        '--dump-json',
        '--flat-playlist',
        '--playlist-end', String(limit + 1),
        '--no-warnings',
        `https://music.youtube.com/watch?v=${videoId}&list=RD${videoId}`
    ]);

    let data = '';
    p.stdout.on('data', c => data += c);

    return new Promise(resolve => {
        p.on('close', async () => {
            try {
                const lines = data.trim().split('\n');
                const songs = [];
                for (let i = 1; i < lines.length; i++) {
                    const r = JSON.parse(lines[i]);
                    const info = await getSongInfo(`https://music.youtube.com/watch?v=${r.id}`);
                    if (info) songs.push(info);
                }
                console.log(`[AUTOPLAY] Fetched ${songs.length} songs`);
                resolve(songs);
            } catch {
                resolve([]);
            }
        });
    });
}

// ===== PLAY SONG =====
async function playSong(guildId, song) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return;

    // ===== AUTOPLAY =====
    if (!song) {
        if (!serverQueue.lastPlayed) return;

        const related = await getAutoplaySongs(serverQueue.lastPlayed.id, 15);
        if (!related.length) return;

        let fresh = related.filter(s => !serverQueue.history.has(s.id));
        if (!fresh.length) {
            serverQueue.history.clear();
            fresh = related;
        }

        const pick = fresh.sort(() => Math.random() - 0.5).slice(0, 3);

        for (const s of pick) {
            serverQueue.songs.push({
                ...s,
                requester: client.user,
                isAutoplay: true
            });
        }

        return playSong(guildId, serverQueue.songs[0]);
    }

    // ===== CLEANUP STREAM =====
    if (serverQueue.streamProcess) {
        try { serverQueue.streamProcess.kill('SIGKILL'); } catch { }
        serverQueue.streamProcess = null;
    }

    // ===== STREAM =====
    console.log(`[PLAY] Playing: ${song.title}`);
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

    // ===== EMBED =====
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
    console.log(`✅ Logged in as ${client.user.tag}`);
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

    let serverQueue = queue.get(guildId);

    if (cmd === 'play') {
        if (!args.length) return message.reply('❌ Please provide a song name.');
        if (!message.member.voice.channel) return message.reply('❌ You must join a voice channel first.');

        message.reply('🔍 Searching for your song...');

        const info = await getSongInfo(args.join(' '));
        if (!info) return message.reply('❌ Song not found.');

        const song = { ...info, requester: message.author, isAutoplay: false };

        if (!serverQueue) {
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
                serverQueue.songs.shift();
                playSong(guildId, serverQueue.songs[0]);
            });

            playSong(guildId, serverQueue.songs[0]);
        } else {
            serverQueue.songs.push(song);
            message.reply(`✅ Added to queue: **${song.title}**`);
        }
    }

    if (cmd === 'skip') {
        if (serverQueue) {
            serverQueue.player.stop();
            message.reply('⏭ Skipped the current song.');
        }
    }

    if (cmd === 'stop') {
        if (serverQueue) {
            serverQueue.songs = [];
            serverQueue.player.stop();
            message.reply('⏹ Music stopped and queue cleared.');
        }
    }

    if (cmd === 'pause') {
        if (serverQueue && serverQueue.player.state.status === 'playing') {
            serverQueue.player.pause();
            message.reply('⏸ Music paused.');
        }
    }

    if (cmd === 'resume') {
        if (serverQueue && serverQueue.player.state.status === 'paused') {
            serverQueue.player.unpause();
            message.reply('▶ Music resumed.');
        }
    }

    if (cmd === 'help') {
        message.channel.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x1db954)
                    .setTitle('🎵 Music Bot Commands')
                    .setDescription('Here are the commands you can use:')
                    .addFields(
                        { name: '.play <song name>', value: 'Play a song or add to the queue', inline: false },
                        { name: '.skip', value: 'Skip the current song', inline: false },
                        { name: '.stop', value: 'Stop the music and clear the queue', inline: false },
                        { name: '.pause', value: 'Pause the current song', inline: false },
                        { name: '.resume', value: 'Resume the paused song', inline: false },
                        { name: '.help', value: 'Show this help message', inline: false }
                    )
                    .setFooter({
                        text: 'Powered by San\'sMusic', iconURL: client.user.displayAvatarURL()
                    })
                    .setTimestamp()
            ]
        });
    }
});

// ===== LOGIN =====
client.login(TOKEN);
