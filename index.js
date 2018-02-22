/*jslint node: true */
"use strict";

var conf = require('byteballcore/conf.js');
var db = require('byteballcore/db.js');
var eventBus = require('byteballcore/event_bus.js');
var headlessWallet = require('headless-byteball');
var desktopApp = require('byteballcore/desktop_app.js');
var objectHash = require('byteballcore/object_hash.js');
var notifications = require('./notifications.js');
var my_address;
var wallet_id;

//******* */
//独自変数
//******* */
var feedname;
var feedvalue;
var state = '';
var welcometext = "";
	welcometext += "コマンド\n";
	welcometext += "[データ追加](command:add)\n";
	welcometext += "[datafeednameから検索](command:search_feedname)\n";
	welcometext += "[datafeedvalueから検索](command:search_feedvalue)\n";
	welcometext += "[全てのデータを表示](command:search_all)\n";

//
if (conf.bRunWitness)
	require('byteball-witness');

const RETRY_TIMEOUT = 5 * 60 * 1000;
var assocQueuedDataFeeds = {};

const WITNESSING_COST = 600; // size of typical witnessing unit
var count_witnessings_available = 0;

if (!conf.bSingleAddress)
	throw Error('oracle must be single address');

if (!conf.bRunWitness)
	headlessWallet.setupChatEventHandlers();

// this duplicates witness code if we are also running a witness
function readNumberOfWitnessingsAvailable(handleNumber) {
	count_witnessings_available--;
	if (count_witnessings_available > conf.MIN_AVAILABLE_WITNESSINGS)
		return handleNumber(count_witnessings_available);
	db.query(
		"SELECT COUNT(*) AS count_big_outputs FROM outputs JOIN units USING(unit) \n\
		WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0", [my_address, WITNESSING_COST],
		function(rows) {
			var count_big_outputs = rows[0].count_big_outputs;
			db.query(
				"SELECT SUM(amount) AS total FROM outputs JOIN units USING(unit) \n\
				WHERE address=? AND is_stable=1 AND amount<? AND asset IS NULL AND is_spent=0 \n\
				UNION \n\
				SELECT SUM(amount) AS total FROM witnessing_outputs \n\
				WHERE address=? AND is_spent=0 \n\
				UNION \n\
				SELECT SUM(amount) AS total FROM headers_commission_outputs \n\
				WHERE address=? AND is_spent=0", [my_address, WITNESSING_COST, my_address, my_address],
				function(rows) {
					var total = rows.reduce(function(prev, row) {
						return (prev + row.total);
					}, 0);
					var count_witnessings_paid_by_small_outputs_and_commissions = Math.round(total / WITNESSING_COST);
					count_witnessings_available = count_big_outputs + count_witnessings_paid_by_small_outputs_and_commissions;
					handleNumber(count_witnessings_available);
				}
			);
		}
	);
}


//****************** */
//DAGへの書き込み部分
//******************
// make sure we never run out of spendable (stable) outputs. Keep the number above a threshold, and if it drops below, produce more outputs than consume.
function createOptimalOutputs(handleOutputs) {
	var arrOutputs = [{
		amount: 0,
		address: my_address
	}];
	readNumberOfWitnessingsAvailable(function(count) {
		if (count > conf.MIN_AVAILABLE_WITNESSINGS)
			return handleOutputs(arrOutputs);
		// try to split the biggest output in two
		db.query(
			"SELECT amount FROM outputs JOIN units USING(unit) \n\
			WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0 \n\
			ORDER BY amount DESC LIMIT 1", [my_address, 2 * WITNESSING_COST],
			function(rows) {
				if (rows.length === 0) {
					notifications.notifyAdminAboutPostingProblem('only ' + count + " spendable outputs left, and can't add more");
					return handleOutputs(arrOutputs);
				}
				var amount = rows[0].amount;
				//	notifications.notifyAdminAboutPostingProblem('only '+count+" spendable outputs left, will split an output of "+amount);
				arrOutputs.push({
					amount: Math.round(amount / 2),
					address: my_address
				});
				console.log('--------------GOTO handleOutputs--------------');
				console.log(arrOutputs);
				handleOutputs(arrOutputs);
			}
		);
	});
}



function postDataFeed(datafeed, onDone) {
	function onError(err) {
		notifications.notifyAdminAboutFailedPosting(err);
		onDone(err);
	}
	var network = require('byteballcore/network.js');
	var composer = require('byteballcore/composer.js');
	createOptimalOutputs(function(arrOutputs) {
		let params = {
			paying_addresses: [my_address],
			outputs: arrOutputs,
			signer: headlessWallet.signer,
			callbacks: composer.getSavingCallbacks({
				ifNotEnoughFunds: onError,
				ifError: onError,
				ifOk: function(objJoint) {
					network.broadcastJoint(objJoint);
					onDone();
				}
			})
		};
		if (conf.bPostTimestamp)
			datafeed.timestamp = Date.now();

		let objMessage = {
			app: "data_feed",
			payload_location: "inline",
			payload_hash: objectHash.getBase64Hash(datafeed),
			payload: datafeed
		};
		params.messages = [objMessage];
		composer.composeJoint(params);
	});
}

function reliablyPostDataFeed(datafeed) {
	var feed_name, feed_value;
	for (var key in datafeed) {
		feed_name = key;
		feed_value = datafeed[key];
		break;
	}
	if (!feed_name)
		throw Error('no feed name');
	if (assocQueuedDataFeeds[feed_name]) // already queued
		return console.log(feed_name + " already queued");
	assocQueuedDataFeeds[feed_name] = feed_value;
	var onDataFeedResult = function(err) {
		if (err) {
			console.log('will retry posting the data feed later');
			setTimeout(function() {
				postDataFeed(datafeed, onDataFeedResult);
			}, RETRY_TIMEOUT + Math.round(Math.random() * 3000));
		}
		else
			delete assocQueuedDataFeeds[feed_name];
	};
	postDataFeed(datafeed, onDataFeedResult);
}


function readExistingData(feed_name, handleResult) {
	if (assocQueuedDataFeeds[feed_name]) {
		return handleResult(true, 0, assocQueuedDataFeeds[feed_name]);
	}
	db.query(
		"SELECT feed_name, is_stable, value \n\
		FROM data_feeds CROSS JOIN unit_authors USING(unit) CROSS JOIN units USING(unit) \n\
		WHERE address=? AND feed_name=?", [my_address, feed_name],
		function(rows) {
			if (rows.length === 0)
				return handleResult(false);
			if (rows.length > 1)
				notifications.notifyAdmin(rows.length + ' entries for feed', feed_name);
			return handleResult(true, rows[0].is_stable, rows[0].value);
		}
	);
}

//*********************************
//データ読み書き実装部
//*********************************
	function handleText(from_address, text, onUnknown){
		text = text.trim();
		var fields = text.split(/ /);
		var command = fields[0].trim().toLowerCase();
		var params =['',''];
		if (fields.length > 1) params[0] = fields[1].trim();
		if (fields.length > 2) params[1] = fields[2].trim();

		var walletDefinedByKeys = require('byteballcore/wallet_defined_by_keys.js');
		var device = require('byteballcore/device.js');


		//状態に応じた処理＊コマンドで分けきれない細かい状態の管理＊
		switch(state){
			case 'add':
				feedname = command;
				state = 'add_data';
				device.sendMessageToDevice(from_address, 'text', "Please enter the content of the data you want to add.\n追加したいデータの内容を入力してください。");
				return;
			case 'add_data':
				feedvalue = command;
				state = '';
				device.sendMessageToDevice(from_address, 'text',"Writing... feedname:"+feedname+"\n" + "feedvalue:"+feedvalue+"\n" + "feedname:"+feedname+"\nfeedvalue:"+feedvalue+"\nをDAGに書き込んでいます。\nしばらくすると反映されます。");

				var datafeed = {};
				var key = feedname;
				datafeed[key] = feedvalue;
				reliablyPostDataFeed(datafeed);

				return;
			case 'search_feedname':
				device.sendMessageToDevice(from_address, 'text', "Searching from feedname \n feednameから検索中・・・");
				searchdatafeedname(device,from_address,command);
				return;
			case 'search_feedvalue':
				device.sendMessageToDevice(from_address, 'text', "Searching from feedvalue \n feedvalueから検索中・・・");
				searchdatafeedvalue(device,from_address,command);
				return;
		}

		//コマンド処理
		switch(command){
			case 'help':
				device.sendMessageToDevice(from_address, 'text',welcometext);
				break;
			case 'address':
				state = 'menu';
				device.sendMessageToDevice(from_address, 'text',my_address);
				break;
			case 'add':
				state = 'add';
				device.sendMessageToDevice(from_address, 'text', "Data not found\n追加したいデータのタイトルを入力してください。");
				break;
			case 'search_feedname':
				state = 'search_feedname';
				device.sendMessageToDevice(from_address, 'text', "Please enter feedname you want to search.\n検索したいデータのfeednameを入力してください。");
				break;
			case 'search_feedvalue':
				state = 'search_feedvalue';
				device.sendMessageToDevice(from_address, 'text', "Please enter feedvalue you want to search.\n検索したいデータのfeedvalueを入力してください。");
				break;
				//search_all
			case 'search_all':
				state = '';
				searchdallatafeed(device,from_address);
				break;
			default:
				if (onUnknown){
					onUnknown(from_address, text);
				}else{
					device.sendMessageToDevice(from_address, 'text', "unrecognized command");
				}
		}
	}

//***************************************
//DAGから該当のデータを検索して結果を返す。
//***************************************
	function searchdatafeedname(device,from_address,search_feed_name){
		search_feed_name = "%"+search_feed_name+"%";
		db.query(
			//"SELECT feed_name, is_stable, value \n\
			//FROM data_feeds CROSS JOIN unit_authors USING(unit) CROSS JOIN units 	USING(unit) \n\
			//WHERE address=? AND feed_name=?", [my_address,search_feed_name],
			"SELECT feed_name, is_stable, value \n\
			FROM data_feeds \n\
			INNER JOIN unit_authors ua ON data_feeds.unit = ua.unit\n\
			INNER JOIN units un ON data_feeds.unit = un.unit \n\
			WHERE address=? AND feed_name LIKE ?", [my_address,search_feed_name],
			function(rows) {
				if (rows.length === 0){
					device.sendMessageToDevice(from_address, 'text', "Data not found\nデータは見つかりませんでした。");
				}
				else{
					var messeage = "以下のデータが見つかりました。";
					for(var i = 0;i<rows.length;i++){
						messeage += "\n\nfeedname:" + rows[i].feed_name + "\n" + "feedvalue:"+ rows[i].value;
					}
					device.sendMessageToDevice(from_address, 'text', messeage);
				}
				state = 'menu';
			}
		);
	}
	function searchdatafeedvalue(device,from_address,search_feed_value){
		search_feed_value = "%"+search_feed_value+"%";
		db.query(
			"SELECT feed_name, is_stable, value \n\
			FROM data_feeds \n\
			INNER JOIN unit_authors ua ON data_feeds.unit = ua.unit\n\
			INNER JOIN units un ON data_feeds.unit = un.unit \n\
			WHERE address=? AND value LIKE ?", [my_address,search_feed_value],
			function(rows) {
				if (rows.length === 0){
					device.sendMessageToDevice(from_address, 'text', "Data not found\nデータは見つかりませんでした。");
				}
				else{
					var messeage = "以下のデータが見つかりました。";
					for(var i = 0;i<rows.length;i++){
						messeage += "\n\nfeedname:" + rows[i].feed_name + "\n" + "feedvalue:"+ rows[i].value;
					}
					device.sendMessageToDevice(from_address, 'text', "Result\n以下のデータが見つかりました。\n" + "feedname:" + rows[0].feed_name + "\n" + "feedvalue:"+ rows[0].value);
				}
				state = 'menu';
			}
		);
	}
	function searchdallatafeed(device,from_address){
		db.query(
			"SELECT feed_name, is_stable, value \n\
			FROM data_feeds \n\
			INNER JOIN unit_authors ua ON data_feeds.unit = ua.unit\n\
			INNER JOIN units un ON data_feeds.unit = un.unit \n\
			WHERE address=?", [my_address],
			function(rows) {
				if (rows.length === 0){
					device.sendMessageToDevice(from_address, 'text', "Data not found\nデータは見つかりませんでした。");
				}
				else{
					var messeage = "以下のデータが見つかりました。";
					for(var i = 0;i<rows.length;i++){
						messeage += "\n\nfeedname:" + rows[i].feed_name + "\n" + "feedvalue:"+ rows[i].value;
					}
					device.sendMessageToDevice(from_address, 'text', messeage);
				}
				state = 'menu';
			}
		);
	}

//******************************
//待ち受けイベント設定
//******************************
eventBus.on('text', function(from_address, text){
		console.log('text from '+from_address+': '+text);

		handleText(from_address, text);
	});
	
	eventBus.on('headless_wallet_ready', function() {
		headlessWallet.readSingleAddress(function(address) {
			my_address = address;
		});
	});

	eventBus.on('paired', function(from_address){
		console.log('paired '+from_address);
		device.sendMessageToDevice(from_address, 'text',welcometext);
	});
