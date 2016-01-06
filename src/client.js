import io from 'socket.io-client';
import ss from 'socket.io-stream';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

const client = io('ws://localhost:3000', {perMessageDeflate: false});
client.compress(false);
let rl = null;
let user = null;
let ssclient = ss(client);

function expandHome(p) {
    var homedir = process.env['HOME'];
    if (!p) return p;
    if (p === '~') return homedir;
    if (p.slice(0, 2) !== '~/') return p;
    return path.join(homedir, p.slice(2));
}

function processCmd(socket, cmd, args) {
    if (cmd === 'send') {
        // get filesize
        if (args.length > 1) {
            let file = args[1];
            file = path.normalize(expandHome(file));
            args[1] = file;
            console.log(file);
            try {
                let stat = fs.statSync(file);
                if (!stat.isFile()) {
                    throw new Error('not a file.');
                }
                console.log('file size: ' + stat.size);
                args.push(stat.size);
            } catch (err) {
                return onReady(socket, {
                    message: 'invalid argument. ' + err
                });
            }
        } else {
            return onReady(socket, {
                message: 'invalid argument.'
            });
        }
    }
    return socket.emit('cmd', {cmd, args});
}

function onReady(socket, data) {
    if (rl) rl.close();
    console.log(data.message);
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question(`[${process.pid}] ${user} $ `, (command) => {
        const [cmd, ...args] = command.split(' ');
        processCmd(socket, cmd, args);
    });
}

ssclient.on('receive_file', (readStream, data) => {
    if (rl) rl.close();
    console.log('receiving file... saving to ' + data.file);
    readStream.pipe(fs.createWriteStream(data.file));
    readStream.on('end', () => {
        console.log('done');
        client.emit('receive_done', {id: data.id});
    });
});

client.on('connect', () => {
    console.log('connected to server! waiting for server message.');
});

client.on('hello', (data) => {
    if (rl) rl.close();
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question(data.message, (username) => {
        console.log('your name: ' + username);
        user = username;
        client.emit('register', {name: username});
        rl.close();
    });
});

client.on('ready', (data) => {
    onReady(client, data);
});

client.on('progress', (data) => {
    if (rl) rl.close();
    console.log('progress: ' + data.percentage);
});

client.on('send_file', (data) => {
    console.log('sending file... ' + data.file);
    let writeStream = ss.createStream();
    ssclient.emit('file_data', writeStream, data);
    fs.createReadStream(data.file).pipe(writeStream);
    writeStream.on('end', () => {
        console.log('incoming stream finished');
    });
});

client.on('request_file', (data) => {
    if (rl) rl.close();
    console.log('get a file request: ' + data.file);
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question('do you accept? (yes/no): ', (accept) => {
        if (accept === 'yes') {
            rl.question('save to: ', (file) => {
                file = path.normalize(expandHome(file));
                client.emit('accept', {file, id: data.id});
            });
        } else {
            client.emit('deny', {id: data.id});
        }
    });
});

client.on('disconnect', () => {
    if (rl) rl.close();
    console.log('client disconnected');
});

client.on('error', (err) => {
    if (rl) rl.close();
    console.log('client error: ' + err);
    process.exit(-1);
});
