const {Client, GatewayIntentBits, Events, Partials, AttachmentBuilder} = require("discord.js");
const puppeteer = require('puppeteer');
const SimpleNodeLogger = require('simple-node-logger')

const config = require("./config.json");
const wikiRegex = /\[\[([^\[\]]*)\]\]|\[([^\[\]]*)\]/gu;

let log = SimpleNodeLogger.createSimpleLogger({
	logFilePath: './logs/requests.log',
	timestampFormat: 'YYYY-MM-DD HH:mm:ss'
});
let errorLog = SimpleNodeLogger.createSimpleLogger({
	logFilePath: './logs/error.log',
	timestampFormat: 'YYYY-MM-DD HH:mm:ss'
});
errorLog.setLevel('error');

var client;
function setup() {
	client = new Client({
		disableEveryone: true,
		disabledEvents: ["TYPING_START"],
		autoReconnect: true,
		intents: [
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.Guilds
		  ],
		partials: [Partials.Channel],
	});

	client.login(config.token).then(() => {
		console.log("Logged in");
	}).catch(reason => errorLog.error(reason));

	client.on("ready", () => {
		console.log(`Ready as ${client.user.username}`);
	});

	client.on(Events.MessageCreate, async message => {
		if (message.author.bot) return;
		let matches = wikiRegex.exec(message.content);
		while (matches) {
			var match = matches[1];
			if (match == undefined)
				match = matches[2];
			let target
			if (match.startsWith("!"))
				target = match.substr(1);
			else
				target = titleCase(match);

			handleItem(target, message);
			matches = wikiRegex.exec(message.content);
		}
	});

	client.on("error", (error) => {
		errorLog.log(error);
		
	});
};

setup();

async function handleItem(itemName, message) {
	var channel = message.channel;
	var guildName = message.guild.name;

	let itemUrlPart = convertToUrlString(itemName);
	let url = config.wikiURL + itemUrlPart;

	let initialMessage = "Retrieving details from the Wiki for **" + itemName + "**";

	let messageId;
	await channel.send(initialMessage)
		.then(message => messageId = message.id)
		.catch(error => {
			errorLog.error(`"${error.message}" "${guildName}" "${itemName}"`);
		});

	if (messageId == null) return;

	getImage(url, guildName).then(result => {
		let outputString = '<' + url + '>';

		if (!result.success) {
			editMessage(channel, messageId, `Could not get details from the Wiki for **${itemName}**`);
			setTimeout(function () {
				channel.messages.fetch(messageId).then(message => {
					message.delete();
				}).catch(() => {
					errorLog.error(`"Could not delete message ${messageId}" "${guildName}" "${outputString}"`);
				});
			}, 2000)
			log.error(`"${guildName}" "${itemName}" "${url}" "INVALID PAGE"`);
			return;
		}

		//log success
		log.info(`"${guildName}" "${itemName}" "${url}"`);

		if (result.textblock) {
			outputString += `\n${result.textblock}`;
		}

		//if no screenshot, just edit the original message
		if (!result.screenshot) {
			editMessage(channel, messageId, outputString);
			return;
		}

		//otherwise delete the message and create a new one with the screenshot
		channel.messages.fetch(messageId).then(message => {
			message.delete();
		}).catch(() => {
			errorLog.error(`"Could not delete message ${messageId}" "${guildName}" "${outputString}"`);
		});
		const attachment = new AttachmentBuilder(result.screenshot)
		channel.send({ content: outputString, files: [attachment] });
	}).catch((reason) => {
		errorLog.error(`"GetImage Failed" "${guildName}" "${reason}"`);
		channel.messages.fetch(messageId).then(message => {
			message.delete();
		}).catch(() => {
			errorLog.error(`"Could not delete message ${messageId}" "${guildName}" "${outputString}"`);
		});
	});
}

function editMessage(channel, messageId, content) {
	channel.messages.fetch(messageId).then(message => {
		message.edit(content);
	}).catch(() => {
		errorLog.error(`"Could not edit message ${messageId}" "${channel.guild.name}" "${content}"`);
	});
}

async function getImage(url, guildName) {
	let output = {
		screenshot: false,
		success: false
	};

	const browser = await puppeteer.launch({
		ignoreHTTPSError: true,
		headless: true,
		handleSIGHUP: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
	});
	const page = await browser.newPage();
	await page.setJavaScriptEnabled(config.enableJavascript); //Disabling Javascript adds 100% increased performance
	await page.setViewport({ 'width': config.width, 'height': config.height }); //Set a tall page so the image isn't covered by popups

	//played around with a few different waitUntils.  This one seemed the quickest.
	//If you don't disable Javascript on the PoE Wiki site, removing this parameter makes it hang
	try {
		await page.goto(url, { waitUntil: 'load' });
	} catch (error) {
		errorLog.error(`"${error.message}" "${guildName}" "${url}"`);
		return output;
	}

	const invalidPage = await page.$(config.wikiInvalidPageSelector);
	if (invalidPage && invalidPage !== null) return output;

	output.success = true;

	var paragraphs = await page.$(config.wikiParagraphsSelector);
	if (await paragraphs.$(config.wikiInfoboxPageContainerSelector))
		output.textblock = await page.evaluate(() => document.querySelector('#mw-content-text > .mw-parser-output > p:nth-of-type(2)').innerText);
	else
		output.textblock = await page.evaluate(() => document.querySelector('#mw-content-text > .mw-parser-output > p:nth-of-type(1)').innerText);

	//remove newlines
	output.textblock = output.textblock.replace(/[\n\r]/g, '');

	async function getScreenshot(selector) {
		const element = await page.$(selector);
		if (!element)
			return;

		let screenshot = await element.screenshot({
			path: 'screenshots/test.png',
		});
		await page.close();
		await browser.close();
		return screenshot;
	}

	output.screenshot = await getScreenshot(config.wikiInfoCardSelector);
	if (output.screenshot) return output;

	output.screenshot = await getScreenshot(config.wikiItemBoxSelector);
	if (output.screenshot) return output;

	output.screenshot = await getScreenshot(config.wikiTableSelector);
	if (output.screenshot) return output;

	await page.close();
	await browser.close();
	return output;
}

function convertToUrlString(name) {
	return name.replace(/ /g, "_");
}

function titleCase(str) {
	let excludedWords = ["of", "and", "the", "to", "at", "for", "league"];
	str = str.toLowerCase();
	let words = str.split(" ");

	words.forEach((word, index) => {
		if (index > 0 && excludedWords.includes(word))
			return;

		words[index] = word.charAt(0).toUpperCase() + word.substr(1);
	})

	return words.join(" ");
};