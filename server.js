/*jslint node: true */
"use strict";

var winston = require("winston"),
    express = require("express"),
    expressJoi = require("express-joi-validator"),
    expressWinston = require("express-winston"),
    bodyparser = require("body-parser"),
    mqtt = require("mqtt"),
    async = require("async"),
    path = require("path"),
    url = require("url"),
    joi = require("joi"),
    yaml = require("js-yaml"),
    jsonfile = require("jsonfile"),
    fs = require("fs"),
    semver = require("semver"),
    influx = require("influx"),
    influxExpress = require("influx-express"),
    request = require("request");

var CONFIG_DIR = process.env.CONFIG_DIR || process.cwd(),
    CONFIG_FILE = path.join(CONFIG_DIR, "config.yml"),
    SAMPLE_FILE = path.join(__dirname, "_config.yml"),
    STATE_FILE = path.join(CONFIG_DIR, "state.json"),
    EVENTS_LOG = path.join(CONFIG_DIR, "events.log"),
    ACCESS_LOG = path.join(CONFIG_DIR, "access.log"),
    ERROR_LOG = path.join(CONFIG_DIR, "error.log"),
    CURRENT_VERSION = require("./package").version,
    TOPIC_STATE = "state",
    TOPIC_COMMAND = "command",
    RETAIN = "retain",
    SUFFIX_STATE = "state_suffix",
    SUFFIX_COMMAND = "command_suffix";

var app = express(),
    client,
    influxClient,
    subscriptions = [],
    callback = "",
    config = {},
    history = {};

// Write all events to disk as well
winston.add(winston.transports.File, {
    filename: EVENTS_LOG,
    json: false
});

/**
 * Load user configuration (or create it)
 * @method loadConfiguration
 * @return {Object} Configuration
 */
function loadConfiguration() {
    if (!fs.existsSync(CONFIG_FILE)) {
        winston.info("No previous configuration found, creating one");
        fs.writeFileSync(CONFIG_FILE, fs.readFileSync(SAMPLE_FILE));
    }

    return yaml.safeLoad(fs.readFileSync(CONFIG_FILE));
}

/**
 * Load the saved previous state from disk
 * @method loadSavedState
 * @return {Object} Configuration
 */
function loadSavedState() {
    var output;
    try {
        output = jsonfile.readFileSync(STATE_FILE);
    } catch (ex) {
        winston.info("No previous state found, continuing");
        output = {
            subscriptions: [],
            callback: "",
            history: {},
            version: "0.0.0"
        };
    }
    return output;
}

/**
 * Resubscribe on a periodic basis
 * @method saveState
 */
function saveState() {
    winston.info("Saving current state");
    jsonfile.writeFileSync(
        STATE_FILE, {
            subscriptions: subscriptions,
            callback: callback,
            history: history,
            version: CURRENT_VERSION
        }, {
            spaces: 4
        }
    );
}

/**
 * Migrate the configuration from the current version to the latest version
 * @method migrateState
 * @param  {String}     version Version the state was written in before
 */
function migrateState(version) {
    // Make sure the object exists
    if (!config.mqtt) {
        config.mqtt = {};
    }

    // This is the previous default, but it's totally wrong
    if (!config.mqtt.preface) {
        config.mqtt.preface = "/smartthings";
    }

    // Default Suffixes
    if (!config.mqtt[SUFFIX_STATE]) {
        config.mqtt[SUFFIX_STATE] = "";
    }
    if (!config.mqtt[SUFFIX_COMMAND]) {
        config.mqtt[SUFFIX_COMMAND] = "";
    }

    // Default retain
    if (config.mqtt[RETAIN] !== false) {
        config.mqtt[RETAIN] = true;
    }

    // Default port
    if (!config.port) {
        config.port = 8080;
    }

    // Default protocol
    if (!url.parse(config.mqtt.host).protocol) {
        config.mqtt.host = "mqtt://" + config.mqtt.host;
    }

    // Stuff was previously in subscription.json, load that and migrate it
    var SUBSCRIPTION_FILE = path.join(CONFIG_DIR, "subscription.json");
    if (semver.lt(version, "1.1.0") && fs.existsSync(SUBSCRIPTION_FILE)) {
        var oldState = jsonfile.readFileSync(SUBSCRIPTION_FILE);
        callback = oldState.callback;
        subscriptions = oldState.topics;
    }

    saveState();
}

/**
 * Handle Device Change/Push event from SmartThings
 *
 * @method handlePushEvent
 * @param  {Request} req
 * @param  {Object}  req.body
 * @param  {String}  req.body.name  Device Name (e.g. "Bedroom Light")
 * @param  {String}  req.body.type  Device Property (e.g. "state")
 * @param  {String}  req.body.value Value of device (e.g. "on")
 * @param  {Result}  res            Result Object
 */
function handlePushEvent(req, res) {
    var topic = getTopicFor(req.body.name, req.body.type, TOPIC_STATE),
        value = req.body.value;

    //winston.info("Incoming message from SmartThings: %s = %s", topic, value);
    //winston.info(req.body);
    history[topic] = value;

    //cpu_load_short,host=server01 value=23422.0 1422568543702900257\n

    //var telegrafMessage = req.body.type + ',host=' + req.body.name + ' value=' + req.body.value + ' ' + Math.round((new Date()).getTime() / 1000) + '\n';
    var telegrafMessage =
        req.body.type +
        ",name=" +
        req.body.name.replace(" ", "-") +
        " " +
        req.body.type +
        "=" +
        req.body.value +
        " " +
        Math.round(new Date().getTime()) +
        "\n";
    //temperature,name=TestMotion temperature=5.42

    var influxFields;
    var logData = false;
    switch (req.body.type) {
        case "temperature":
            influxFields = {
                temperature: parseFloat(req.body.value),
                units: "DegF"
            };
            logData = true;
            break;
        case "power":
            influxFields = {
                power: parseFloat(req.body.value)
            };
            logData = true;
            break;
        case "humidity":
            influxFields = {
                humidity: parseFloat(req.body.value),
                units: "%"
            };
            logData = true;
            break;
        case "battery":
            influxFields = {
                battery: parseFloat(req.body.value),
                units: "%"
            };
            logData = true;
            break;
        case "motion":
            influxFields = {
                motion: req.body.value
            };
            logData = true;
            break;
        case "energy":
            influxFields = {
                energy: req.body.value
            };
            logData = true;
            break;
        case "trackDescription":
            influxFields = {
                trackName: req.body.value
            };
            logData = true;
            break;
        case "illuminance":
            influxFields = {
                illuminance: parseFloat(req.body.value)
            };
            logData = true;
            break;
        case 'door':
            influxFields = {
                door: req.body.value
            };
            logData = true;
            break;
        case 'thermostatOperatingState':
            influxFields = {
                thermostatOperatingState: req.body.value
            };
            logData = true;
            break;
        case 'switch':
            influxFields = {
                switch: req.body.value
            };
            logData = true;
            break;

        case 'contact':
            influxFields = {
                contact: req.body.value
            };
            logData = true;
            break;

        case 'presence':
            influxFields = {
                presence: req.body.value
            };
            logData = true;
            break;

        case 'trackData':
            influxFields = {
                trackData: req.body.value
            };
            logData = true;
            break;

        case 'status':
            influxFields = {
                status: req.body.value
            };
            logData = true;
            break;



        case "level":
            influxFields = {
                level: parseFloat(req.body.value)
            };
            logData = true;
            break;
        case "heatingSetpoint":
            influxFields = {
                heatingSetpoint: parseFloat(req.body.value)
            };
            logData = true;
            break;

        case "thermostatSetpoint":
            influxFields = {
                thermostatSetpoint: parseFloat(req.body.value)
            };
            logData = true;
            break;
        case "voltage":
            influxFields = {
                voltage: parseFloat(req.body.value)
            };
            logData = true;
            break;
    }

    if (logData) {
        //winston.info("Writing to Influx");
        influxClient
            .writePoints([{
                measurement: 'sensordata',
                tags: {
                    name: req.body.name.replace(" ", "-"),
                    type: req.body.type,
                    deviceModel: req.body.deviceType,
                    source: req.body.source
                },
                fields: influxFields
                    // timestamp: Math.round(new Date().getTime())
            }])
            .then(
                idbValue => {
                    //winston.info(idbValue);
                    //winston.info("Completed Write to InFluxDB");
                },
                idbValue => {
                    winston.error(idbValue);
                }
            )
            .catch(err => {
                winston.error(`Error saving data to InfluxDB! ${err.stack}`);
                //console.error(`Error saving data to InfluxDB! ${err.stack}`)
            });
    } else {
        winston.error('*** No Handler for ' + req.body.type);
    }

    var telegrafTopic = config.mqtt.preface + "/telegraf";

    client.publish(
        telegrafTopic,
        telegrafMessage, {
            retain: config.mqtt[RETAIN]
        },
        function() {
            // winston.info("Published telegraph Message to MQTT: " + telegrafMessage);
        }
    );

    var jsonTopic = config.mqtt.preface + "/json";
    client.publish(
        jsonTopic,
        req.body, {
            retain: config.mqtt[RETAIN]
        },
        function() {
            //winston.info("Published json Message to MQTT: " + req.body);
        }
    );

    client.publish(
        topic,
        value, {
            retain: config.mqtt[RETAIN]
        },
        function() {
            res.send({
                status: "OK"
            });
        }
    );
}

/**
 * Handle Subscribe event from SmartThings
 *
 * @method handleSubscribeEvent
 * @param  {Request} req
 * @param  {Object}  req.body
 * @param  {Object}  req.body.devices  List of properties => device names
 * @param  {String}  req.body.callback Host and port for SmartThings Hub
 * @param  {Result}  res               Result Object
 */
function handleSubscribeEvent(req, res) {
    // Subscribe to all events
    subscriptions = [];
    Object.keys(req.body.devices).forEach(function(property) {
        req.body.devices[property].forEach(function(device) {
            subscriptions.push(getTopicFor(device, property, TOPIC_COMMAND));
        });
    });

    // Store callback
    callback = req.body.callback;

    // Store current state on disk
    saveState();

    // Subscribe to events
    //winston.info("Subscribing to " + subscriptions.join(", "));
    client.subscribe(subscriptions, function() {
        res.send({
            status: "OK"
        });
    });
}

/**
 * Get the topic name for a given item
 * @method getTopicFor
 * @param  {String}    device   Device Name
 * @param  {String}    property Property
 * @param  {String}    type     Type of topic (command or state)
 * @return {String}             MQTT Topic name
 */
function getTopicFor(device, property, type) {
    var tree = [config.mqtt.preface, device, property],
        suffix;

    if (type === TOPIC_COMMAND) {
        suffix = config.mqtt[SUFFIX_COMMAND];
    } else if (type === TOPIC_STATE) {
        suffix = config.mqtt[SUFFIX_STATE];
    }

    if (suffix) {
        tree.push(suffix);
    }

    return tree.join("/");
}

/**
 * Parse incoming message from MQTT
 * @method parseMQTTMessage
 * @param  {String} topic   Topic channel the event came from
 * @param  {String} message Contents of the event
 */
function parseMQTTMessage(topic, message) {
    var contents = message.toString();
    // winston.info("Incoming message from MQTT: %s = %s", topic, contents);

    // Remove the preface from the topic before splitting it
    var pieces = topic.substr(config.mqtt.preface.length + 1).split("/"),
        device = pieces[0],
        property = pieces[1],
        topicState = getTopicFor(device, property, TOPIC_STATE),
        topicSwitchState = getTopicFor(device, "switch", TOPIC_STATE),
        topicLevelCommand = getTopicFor(device, "level", TOPIC_COMMAND);

    if (history[topicState] === contents) {
        //   winston.info("Skipping duplicate message from: %s = %s", topic, contents);
        return;
    }
    history[topic] = contents;

    // If sending level data and the switch is off, don't send anything
    // SmartThings will turn the device on (which is confusing)
    if (property === "level" && history[topicSwitchState] === "off") {
        winston.info("Skipping level set due to device being off");
        return;
    }

    // If sending switch data and there is already a level value, send level instead
    // SmartThings will turn the device on
    if (
        property === "switch" &&
        contents === "on" &&
        history[topicLevelCommand] !== undefined
    ) {
        winston.info("Passing level instead of switch on");
        property = "level";
        contents = history[topicLevelCommand];
    }

    request.post({
            url: "http://" + callback,
            json: {
                name: device,
                type: property,
                value: contents
            }
        },
        function(error, resp) {
            if (error) {
                // @TODO handle the response from SmartThings
                winston.error("Error from SmartThings Hub: %s", error.toString());
                winston.error(JSON.stringify(error, null, 4));
                winston.error(JSON.stringify(resp, null, 4));
            }
        }
    );
}

// Main flow
async.series(
    [
        function loadFromDisk(next) {
            var state;

            winston.info("Starting SmartThings MQTT Bridge - v%s", CURRENT_VERSION);
            winston.info("Loading configuration");
            config = loadConfiguration();

            winston.info("Loading previous state");
            state = loadSavedState();
            callback = state.callback;
            subscriptions = state.subscriptions;
            history = state.history;

            winston.info("Perfoming configuration migration");
            migrateState(state.version);

            process.nextTick(next);
        },
        function connectToMQTT(next) {
            winston.info("Connecting to MQTT at %s", config.mqtt.host);

            client = mqtt.connect(config.mqtt.host, config.mqtt);
            client.on("message", parseMQTTMessage);
            client.on("connect", function() {
                if (subscriptions.length > 0) {
                    client.subscribe(subscriptions);
                }
                next();
                // @TODO Not call this twice if we get disconnected
                next = function() {};
            });
        },
        function connectToInflux(next) {
            winston.info("Connecting to InfluxDB");

            influxClient = new influx.InfluxDB({
                host: config.influx.server,
                database: config.influx.database,
                username: config.influx.username,
                password: config.influx.password,
                schema: [{
                    measurement: "sensordata",
                    fields: {
                        temperature: influx.FieldType.FLOAT,
                        power: influx.FieldType.FLOAT,
                        energy: influx.FieldType.FLOAT,
                        humidity: influx.FieldType.FLOAT,
                        voltage: influx.FieldType.FLOAT,
                        motion: influx.FieldType.STRING,
                        contact: influx.FieldType.STRING,
                        presence: influx.FieldType.STRING,
                        status: influx.FieldType.STRING,
                        trackData: influx.FieldType.STRING,

                        battery: influx.FieldType.FLOAT,
                        level: influx.FieldType.FLOAT,
                        heatingSetpoint: influx.FieldType.FLOAT,
                        thermostatSetpoint: influx.FieldType.FLOAT,
                        trackName: influx.FieldType.STRING,
                        units: influx.FieldType.STRING,
                        illuminance: influx.FieldType.FLOAT,
                        door: influx.FieldType.STRING,
                        thermostatOperatingState: influx.FieldType.STRING,
                        switch: influx.FieldType.STRING
                    },
                    tags: ["name", "type", "source", "deviceModel"]
                }]
            });
            process.nextTick(next);
        },
        function configureCron(next) {
            winston.info("Configuring autosave");

            // Save current state every 15 minutes
            setInterval(saveState, 15 * 60 * 1000);

            process.nextTick(next);
        },
        function setupApp(next) {
            winston.info("Configuring API");

            // Accept JSON
            app.use(bodyparser.json());

            var influxOpts = {
                protocol: "http",
                host: config.influx.server,
                port: 8086,
                database: config.influx.database,
                username: config.influx.username,
                password: config.influx.password,
                batchSize: 10
            };

            app.use(influxExpress(influxOpts));
            // Log all requests to disk
            app.use(
                expressWinston.logger({
                    transports: [
                        new winston.transports.File({
                            filename: ACCESS_LOG,
                            json: true
                        })
                    ]
                })
            );

            app.post("/initial", function(req, res) {
                //winston.info(req.body);
                res.send({
                    status: "OK"
                });
            });
            app.post("/update", function(req, res) {
                //winston.info(req.body);
                res.send({
                    status: "OK"
                });
            });
            // Push event from SmartThings
            app.post(
                "/push",
                expressJoi({
                    body: {
                        //   "name": "Energy Meter",
                        name: joi.string().required(),
                        //   "value": "873",
                        value: joi.string().required(),
                        //   "type": "power",
                        type: joi.string().required(),
                        evtDate: joi.date().allow(),
                        source: joi.string().allow(),
                        digital: joi.bool().allow(),
                        physical: joi.bool().allow(),
                        stateChange: joi.bool().allow(),
                        data: joi.string().allow(),
                        description: joi.string().allow(),
                        deviceManuf: joi.string().allow(),
                        deviceModel: joi.string().allow(),
                        deviceType: joi.string().allow()

                    }
                }),
                handlePushEvent
            );

            // Subscribe event from SmartThings
            app.post(
                "/subscribe",
                expressJoi({
                    body: {
                        devices: joi.object().required(),
                        callback: joi.string().required()
                    }
                }),
                handleSubscribeEvent
            );

            // Log all errors to disk
            app.use(
                expressWinston.errorLogger({
                    transports: [
                        new winston.transports.File({
                            filename: ERROR_LOG,
                            json: false
                        })
                    ]
                })
            );

            // Proper error messages with Joi
            app.use(function(err, req, res, next) {
                if (err.isBoom) {
                    return res.status(err.output.statusCode).json(err.output.payload);
                }
            });

            app.listen(config.port, next);
        }
    ],
    function(error) {
        if (error) {
            return winston.error(error);
        }
        winston.info("Listening at http://localhost:%s", config.port);
    }
);