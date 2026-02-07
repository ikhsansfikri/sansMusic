const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Events
} = require('discord.js');

const { AudioPlayerStatus } = require('@discordjs/voice'); // <- PENTING

const client = require('./client');
const { PREFIX } = require('./config');
const { queue, playSong } = require('./player');
const { getSongInfo } = require('./utils/search');
const { formatTime, createProgressBar } = require('./utils/time');

// =========================
// MESSAGE CREATE EVENT
// =========================
client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const guildId = message.guild.id;
    let serverQueue = queue.get(guildId);

    // =========================
    // PLAY COMMAND
    // =========================
    if (cmd === 'play' || cmd === 'p') {
        if (!args.length) return message.reply('❌ Please provide a song name.');
        if (!message.member.voice.channel) return message.reply('❌ You must join a voice channel first.');

        message.reply('🔍 Searching...');
        const info = await getSongInfo(args.join(' '));
        if (!info) return message.reply('❌ Song not found.');

        const song = { ...info, requester: message.author, isAutoplay: false };

        if (!serverQueue) {
            const { createAudioPlayer, joinVoiceChannel } = require('@discordjs/voice');
            const player = createAudioPlayer();

            const connection = joinVoiceChannel({
                channelId: message.member.voice.channel.id,
                guildId,
                adapterCreator: message.guild.voiceAdapterCreator
            });

            serverQueue = {
                textChannel: message.channel,
                voiceChannel: message.member.voice.channel,
                connection,
                player,
                songs: [],
                lastPlayed: null,
                streamProcess: null,
                history: new Set()
            };
            queue.set(guildId, serverQueue);
            serverQueue.songs.push(song);
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

    // =========================
    // SKIP COMMAND
    // =========================
    if (cmd === 'skip' || cmd === 's') {
        if (serverQueue) {
            serverQueue.player.stop();
            message.reply('⏭ Skipped the current song.');
        } else {
            message.reply('❌ Nothing is playing.');
        }
    }

    // =========================
    // STOP COMMAND
    // =========================
    if (cmd === 'stop') {
        if (serverQueue) {
            serverQueue.songs = [];
            serverQueue.player.stop();
            queue.clear();
            message.reply('⏹ Music stopped and queue cleared.');
        } else {
            message.reply('❌ Nothing is playing.');
        }
    }

    // =========================
    // PAUSE COMMAND
    // =========================
    if (cmd === 'pause') {
        if (serverQueue && serverQueue.player.state.status === 'playing') {
            serverQueue.player.pause();
            message.reply('⏸ Music paused.');
        } else {
            message.reply('❌ Nothing is playing.');
        }
    }

    // =========================
    // RESUME COMMAND
    // =========================
    if (cmd === 'resume' || cmd === 'r') {
        if (serverQueue && serverQueue.player.state.status === 'paused') {
            serverQueue.player.unpause();
            message.reply('▶ Music resumed.');
        } else {
            message.reply('❌ Nothing is paused.');
        }
    }

    // =========================
    // QUEUE COMMAND
    // =========================
    if (cmd === 'queue' || cmd === 'list' || cmd === 'l') {
        if (!serverQueue || serverQueue.songs.length === 0) {
            return message.reply('📭 The queue is currently empty.');
        }

        const pageSize = 5;
        let page = 0;
        const totalPages = Math.ceil(serverQueue.songs.length / pageSize);

        const buildEmbed = () => {
            const now = serverQueue.songs[0];
            const elapsed = Math.floor((Date.now() - (serverQueue.songStartTime || Date.now())) / 1000);
            const progress = createProgressBar(elapsed, serverQueue.currentDurationSec);
            const timeText = serverQueue.currentDurationSec
                ? `${formatTime(elapsed)} / ${formatTime(serverQueue.currentDurationSec)}`
                : 'Live';

            const start = page * pageSize;
            const songs = serverQueue.songs.slice(start, start + pageSize);

            const list = songs.map((s, i) => {
                const index = start + i;
                return index === 0
                    ? `▶ **${s.title}**`
                    : `**${index}.** ${s.title} \`${s.duration}\`${s.isAutoplay ? ' *(Autoplay)*' : ''}`;
            }).join('\n');

            return new EmbedBuilder()
                .setColor(0x1db954)
                .setAuthor({
                    name: now.isAutoplay ? `${client.user.username} • Autoplay` : client.user.username,
                    iconURL: client.user.displayAvatarURL()
                })
                .setTitle('🎶 Music Queue')
                .setThumbnail(now.thumbnail || serverQueue.textChannel.guild.iconURL())
                .addFields(
                    { name: 'Now Playing', value: `**${now.title}**\n${progress}\n⏱ ${timeText}` },
                    { name: `Queue (Page ${page + 1}/${totalPages})`, value: list || 'Empty' }
                )
                .setFooter({ text: `Total songs: ${serverQueue.songs.length}` })
                .setTimestamp();
        };

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('next').setLabel('▶').setStyle(ButtonStyle.Secondary)
        );

        const msg = await message.channel.send({
            embeds: [buildEmbed()],
            components: totalPages > 1 ? [row] : []
        });

        const collector = msg.createMessageComponentCollector({ time: 60_000 });

        collector.on('collect', i => {
            if (i.user.id !== message.author.id)
                return i.reply({ content: '❌ This queue is not for you.', ephemeral: true });

            if (i.customId === 'prev') page = Math.max(page - 1, 0);
            if (i.customId === 'next') page = Math.min(page + 1, totalPages - 1);

            i.update({ embeds: [buildEmbed()] });
        });

        collector.on('end', () => {
            msg.edit({ components: [] }).catch(() => { });
        });
    }

    // =========================
    // HELP COMMAND
    // =========================
    if (cmd === 'help' || cmd === 'h') {
        const embed = new EmbedBuilder()
            .setColor(0x1db954)
            .setTitle('🎵 Music Bot Commands')
            .setDescription('Here are the commands you can use:')
            .addFields(
                { name: "-play <song name or link> | -p", value: 'Play a song or add to the queue', inline: false },
                { name: "-skip | -s", value: 'Skip the current song', inline: false },
                { name: "-stop", value: 'Stop the music and clear the queue', inline: false },
                { name: "-pause", value: 'Pause the current song', inline: false },
                { name: "-resume | -r", value: 'Resume the paused song', inline: false },
                { name: "-queue | -list | -l", value: 'Show the current music queue', inline: false },
                { name: "-help | -h", value: 'Show this help message', inline: false }
            )
            .setFooter({ text: 'Powered by San\'sMusic', iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        message.channel.send({ embeds: [embed] });
    }
});
