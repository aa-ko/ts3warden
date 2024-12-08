import {TeamSpeak, QueryProtocol, TeamSpeakClient, TextMessageTargetMode} from "ts3-nodejs-library"
import format from 'format-duration';
import {exit} from "process";
import date from 'date-and-time';
import toml from 'toml';
import {readFile} from "fs/promises";
import {Counter, Gauge} from "prom-client";
import {z} from "zod";
import Database from "bun:sqlite";
import {pino} from "pino";

var protectedUsers: Map<string, Date> = new Map();

const configSchema = z.object({
    general: z.object({
        host: z.string(),
        serverport: z.number(),
        queryport: z.number(),
        nickname: z.string(),
        username: z.string(),
        password: z.string(),
    }),
    moderation: z.object({
        idletime: z.number(),
    }),
    db: z.object({
        path: z.string()
    })
});

const logger = pino({
    level: 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
        }
    }
});

logger.info("Starting ts3warden...")

const config = await readConfig("./ts3warden.toml");

let db = new Database(config.db.path);
logger.info("Connected to SQLite db: " + config.db.path);

logger.info("Connecting to TeamSpeak server: " + config.general.host + ":" + config.general.serverport);
const teamspeak = await TeamSpeak.connect({
    host: config.general.host,
    protocol: QueryProtocol.RAW,
    serverport: config.general.serverport,
    queryport: config.general.queryport,
    nickname: config.general.nickname,
    username: config.general.username,
    password: config.general.password,
    ignoreQueries: true
});

const me = await teamspeak.whoami()
logger.debug(JSON.stringify(me))
logger.info("Connected to Teamspeak server.")

await logServerInfo(db, teamspeak);

// Automatically reconnect on connection loss.
teamspeak.on("close", async (err) => {
    logger.warn(JSON.stringify(err))
    logger.warn("Connection lost, trying to reconnect...");
    await teamspeak.reconnect(-1, 1000);
    logger.warn("Reconnected!");
});

teamspeak.on("textmessage", async (e) => {
    // This is the bot itself, so we do nothing.
    if (e.targetmode === TextMessageTargetMode.CLIENT || e.invoker.clid !== me.clientId) {
        logger.debug(`I saw a message from "${e.invoker.nickname}": ${e.msg}`);
        if (e.msg.startsWith("!stop")) {
            // Found someone who wishes to be left alone.
            logger.info(`Got protection request from user '${e.invoker.nickname}' with ID '${e.invoker.clid}'.`);
            protectedUsers.set(e.invoker.clid, date.addHours(new Date(), 3));
            logger.info(`New protection list: ${formatProtectedUsers()}`)
            await trySendMessage(e.invoker, "Na gut, ich move dich die nächsten drei Stunden nicht mehr :(")
        }
    }
});

teamspeak.on("clientconnect", async (e) => {
    await handleClientListChange(db, e.client);
});

// teamspeak.on("clientdisconnect", async (e) => {
//     await handleClientListChange(e.client);
//     // This will always be undefined???
// })

teamspeak.on("error", async (err) => {
    logger.error(`Something went wrong: ${err}`)
});

setInterval(async () => {
    //logger.debug("Starting server info metrics collection.");
    //await logServerInfo(db, teamspeak);

    // Update protection list
    logger.debug("Checking for client to remove from protection list...");
    logger.debug(`Current protection list: ${formatProtectedUsers()}`)
    const now = new Date();
    // TODO: This SUCKS! Use event based system and just wait for a timer to end and call some delegate to remove a user from the list.
    protectedUsers.forEach((v, k) => {
        if (date.subtract(now, v).toMinutes() > 0) {
            logger.info(`Client with ID '${k}' is no longer protected.`);
            protectedUsers.delete(k);
        }
    });

    // Move idle clients
    logger.debug("Checking for idle clients..");
    const clients = await teamspeak.clientList({clientType: 0});
    // TODO: This should be configurable.
    const lobby = await teamspeak.getChannelByName("Lobby");
    if (!lobby) {
        logger.error("Unable to find Lobby!");
        exit(1);
    }
    for (const client of clients) {
        if (client.cid !== lobby.cid) {
            const idleTime = client.idleTime;
            if (idleTime > config.moderation.idletime * 60 * 1000) {
                if (protectedUsers.has(client.clid)) {
                    logger.debug(`User with ID '${client.clid}' is protected and won't be moved.`);
                } else {
                    const formatOptions = {
                        leading: true
                    };
                    const idleTimeFormatted = format(idleTime, formatOptions);
                    logger.info(`Client ${client.nickname} has been idle for ${idleTimeFormatted} and will be moved to the Lobby..`);
                    await trySendMessage(client, `Ey ${client.nickname}, idle mal hier nicht rum. Ab in die Lobby mit dir!`)
                    await client.move(lobby.cid);
                }
            }
        }
    }
}, config.moderation.idletime * 1000);

const currentUsers = new Gauge({
    name: "users_online",
    help: "Number of currently connected users",
    collect: async () => {
        const users = (await teamspeak.serverInfo()).virtualserverClientsonline;
        // @ts-ignore
        this.set(users);
    }
});

async function readConfig(path: string) {
    const configRaw = await readFile(path, {encoding: "utf-8"});
    const config = toml.parse(configRaw);
    const validConfig = configSchema.parse(config);
    logger.info("Loaded config from file.");
    return validConfig;
}

async function trySendMessage(client: TeamSpeakClient, msg: string) {
    try {
        logger.debug(`Sending message to user '${client.nickname}': ${msg}`)
        client.message(msg);
    } catch (error) {
        logger.warn(`Error when sending the message: ${error}`)
    }
}

function formatProtectedUsers() {
    return `[ ${[...protectedUsers.keys()].join(", ")} ]`
}

async function handleClientListChange(db: Database, client: TeamSpeakClient) {
    const res = db.run("INSERT INTO clientinfo VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        getCurrentUnixTime(),
        client.clid,
        client.cid,
        client.databaseId,
        client.nickname,
        client.isRecording,
        client.uniqueIdentifier,
        client.version,
        client.platform,
        client.created,
        client.lastconnected,
        client.country || null,
        client.connectionClientIp
    ]);
}

async function logServerInfo(db: Database, teamspeak: TeamSpeak) {
    // TODO: This is a no-op for now. We do not need so much stuff in the DB.
    return;
    const info = await teamspeak.serverInfo();
    // const res = db.run("INSERT INTO serverinfo VALUES(?,?,?,?,?,?,?)", [
    //     getCurrentUnixTime(),
    //     info.virtualserverWelcomemessage,
    //     info.virtualserverVersion, // ??????
    //     info.virtualserverClientsonline,
    //     info.virtualserverUptime,
    //     info.connectionBytesSentTotal,
    //     info.connectionBytesReceivedTotal
    // ]);
}

function getCurrentUnixTime() {
    return (new Date()).getTime()
}
