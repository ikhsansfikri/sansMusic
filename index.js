require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActivityType } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    getVoiceConnection
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

// ===== GET SONG INFO =====
function getSongInfo(query) {
    return new Promise(resolve => {
        const p = spawn(YT_DLP_COMMAND, [
            '--dump-json',
            '--default-search', 'ytsearch',
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
                    url: r.webpage_url,
                    webpage_url: r.webpage_url,
                    duration: r.duration_string || 'Live',
                    id: r.id,
                    thumbnail: r.thumbnail
                });
            } catch {
                resolve(null);
            }
        });
    });
}

// ===== AUTOPLAY =====
function getRelatedSong(videoId) {
    return new Promise(resolve => {
        const p = spawn(YT_DLP_COMMAND, [
            '--dump-json',
            '--flat-playlist',
            '--playlist-end', '2',
            `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`
        ]);

        let data = '';
        p.stdout.on('data', c => data += c);

        p.on('close', () => {
            try {
                const lines = data.trim().split('\n');
                const r = JSON.parse(lines[1]);

                resolve({
                    title: r.title,
                    url: `https://www.youtube.com/watch?v=${r.id}`,
                    webpage_url: `https://www.youtube.com/watch?v=${r.id}`,
                    duration: 'Unknown',
                    id: r.id
                });
            } catch {
                resolve(null);
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

        const rec = await getRelatedSong(serverQueue.lastPlayed.id);
        if (!queue.has(guildId) || !rec) return;

        serverQueue.songs.push({
            ...rec,
            requester: client.user,
            isAutoplay: true
        });

        return playSong(guildId, serverQueue.songs[0]);
    }

    if (serverQueue.streamProcess) {
        serverQueue.streamProcess.kill('SIGKILL');
        serverQueue.streamProcess = null;
    }

    const child = spawn(YT_DLP_COMMAND, [
        song.webpage_url,
        '-o', '-',
        '-f', 'bestaudio',
        '--no-playlist',
        '-q'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    serverQueue.streamProcess = child;

    const resource = createAudioResource(child.stdout);
    serverQueue.player.play(resource);
    serverQueue.lastPlayed = song;

    // ===== EMBED NOW PLAYING =====
    const embed = new EmbedBuilder()
        .setColor(song.isAutoplay ? 0x9b59b6 : 0x1db954)
        .setAuthor({
            name: song.isAutoplay ? 'Autoplay' : 'Now Playing',
            iconURL: song.requester.displayAvatarURL()
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

    serverQueue.textChannel.send({ embeds: [embed] });
}

// ===== READY =====
client.once(Events.ClientReady, () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    client.user.setPresence({
        activities: [{ name: '.play | music', type: ActivityType.Listening }],
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

        const song = {
            ...info,
            requester: message.author,
            isAutoplay: false
        };

        let serverQueue = queue.get(guildId);

        if (!serverQueue) {
            const player = createAudioPlayer();
            serverQueue = {
                textChannel: message.channel,
                voiceChannel: message.member.voice.channel,
                connection: null,
                player,
                songs: [],
                lastPlayed: null,
                streamProcess: null
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
            message.reply(`✅ Ditambahkan ke queue: **${song.title}**`);
        }
    }

    if (cmd === 'skip') {
        const serverQueue = queue.get(guildId);
        if (!serverQueue) return;
        serverQueue.player.stop();
    }

    if (cmd === 'stop') {
        const serverQueue = queue.get(guildId);
        if (!serverQueue) return;
        serverQueue.songs = [];
        serverQueue.player.stop();
    }
});

// ===== LOGIN =====
client.login(TOKEN);
