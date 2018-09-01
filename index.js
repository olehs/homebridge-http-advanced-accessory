var Service, Characteristic;
var request = require("request");
var xpath = require("xpath");
var dom = require("xmldom").DOMParser;
var JSONPath = require("JSONPath");
var pollingtoevent = require('polling-to-event');

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	homebridge.registerAccessory("homebridge-http-advanced-accessory", "HttpAdvancedAccessory", HttpAdvancedAccessory);
};

/**
 * Mapper class that can be used as a dictionary for mapping one value to another
 *
 * @param {Object} parameters The parameters of the mapper
 * @constructor
 */
function StaticMapper(parameters) {
	var self = this;
	self.mapping = parameters.mapping;

	self.map = function(value) {
		return self.mapping[value] || value;
	};
}

/**
 * Mapper class that can extract a part of the string using a regex
 *
 * @param {Object} parameters The parameters of the mapper
 * @constructor
 */
function RegexMapper(parameters) {
	var self = this;
	self.regexp = new RegExp(parameters.regexp);
	self.capture = parameters.capture || "1";

	self.map = function(value) {
		var matches = self.regexp.exec(value);

		if (matches !== null && self.capture in matches) {
			return matches[self.capture];
		}

		return value;
	};
}

/**
 * Mapper class that uses XPath to select the text of a node or the value of an attribute
 *
 * @param {Object} parameters The parameters of the mapper
 * @constructor
 */
function XPathMapper(parameters) {
	var self = this;
	self.xpath = parameters.xpath;
	self.index = parameters.index || 0;

	self.map = function(value) {
		var document = new dom().parseFromString(value);
		var result  = xpath.select(this.xpath, document);

		if (typeof result == "string") {
			return result;
		} else if (result instanceof Array && result.length > self.index) {
			return result[self.index].data;
		}

		return value;
	};
}

/**
 * Mapper class that uses JSONPath to select the text of a node or the value of an attribute
 *
 * @param {Object} parameters The parameters of the mapper
 * @constructor
 */
function JPathMapper(parameters) {
	var self = this;
	self.jpath = parameters.jpath;
	self.index = parameters.index || 0;

	self.map = function(value) {
		var json = JSON.parse(value);
		var result  = JSONPath({path: self.jpath, json: json});

		if (result instanceof Array && result.length > self.index) {
			result = result[self.index];
		}
		
		if (result instanceof Object) {
			return JSON.stringify(result);
		}

		return result;
	};
}

function HttpAdvancedAccessory(log, config) {
	var self = this;

	self.log = log;
	self.debug = config.debug;
	
	self.name = config.name;
	self.services = config.services;
	self.forceRefreshDelay = config.forceRefreshDelay;

	self.auth = {
		username: config.username || "",
		password: config.password || "",
		immediately: true
	};

	if ("immediately" in config) {
		self.auth.immediately = config.immediately;
	}

	self.createAction = function (actionDescription) {
		var action = {};

		if (!(actionDescription instanceof Object)) {
			action.url = actionDescription;
			action.httpMethod = "GET";
			action.body = "";
			return action;
		}

		action.url = actionDescription.url;
		action.httpMethod = actionDescription.httpMethod || "GET";
		action.body = actionDescription.body || "";

		if (actionDescription.mappers) {
			action.mappers = [];
			actionDescription.mappers.forEach(function(matches) {
				switch (matches.type) {
					case "regex":
						action.mappers.push(new RegexMapper(matches.parameters));
						break;
					case "static":
						action.mappers.push(new StaticMapper(matches.parameters));
						break;
					case "xpath":
						action.mappers.push(new XPathMapper(matches.parameters));
						break;
					case "jpath":
						action.mappers.push(new JPathMapper(matches.parameters));
						break;
				}
			});
		}

		if(actionDescription.inconclusive) {
			action.inconclusive = createAction(actionDescription.inconclusive);
		}

		return action;
	};

	if ("identify" in config) {
		self.identifyAction = self.createAction(config.identify);
	}

}



HttpAdvancedAccessory.prototype = {
	/**
 * Logs a message to the HomeBridge log
 *
 * Only logs the message if the debug flag is on.
 */
	debugLog : function () {
		if (this.debug) {
			this.log.apply(this, arguments);
		}
	},
/**
 * Method that performs a HTTP request
 *
 * @param url The URL to hit
 * @param body The body of the request
 * @param callback Callback method to call with the result or error (error, response, body)
 */
	httpRequest : function(url, body, httpMethod, callback) {
		request({
			url: url,
			body: body,
			method: httpMethod,
			auth: {
				user: this.auth.username,
				pass: this.auth.password,
				sendImmediately: this.auth.immediately
			},
			headers: {
				Authorization: "Basic " + new Buffer(this.auth.username + ":" + this.auth.password).toString("base64")
			}
		},
		function(error, response, body) {
			callback(error, response, body)
		});
	},

/**
 * Applies the mappers to the state string received
 *
 * @param {string} string The string to apply the mappers to
 * @returns {string} The modified string after all mappers have been applied
 */
	applyMappers : function(mappers, string) {
		var self = this;

		if (mappers && mappers.length > 0) {
			self.debugLog("Applying mappers on " + string);
			mappers.forEach(function (mapper, index) {
				var newString = mapper.map(string);
				self.debugLog("Mapper " + index + " mapped " + string + " to " + newString);
				string = newString;
			});

			self.debugLog("Mapping result is " + string);
		}

		return string;
	},

	stringInject : function(str, data) {
		if (typeof str === 'string' && (data instanceof Array)) {
	
			return str.replace(/({\d})/g, function(i) {
				return data[i.replace(/{/, '').replace(/}/, '')];
			});
		} else if (typeof str === 'string' && (data instanceof Object)) {
	
			for (let key in data) {
				return str.replace(/({([^}]+)})/g, function(i) {
					let key = i.replace(/{/, '').replace(/}/, '');
					if (!data[key]) {
						return i;
					}
	
					return data[key];
				});
			}
		} else {
	
			return false;
		}
	},

	//Start
	identify: function (callback) {
		this.log("Identify requested!");
		this.getDispatch(callback, this.identifyAction);
	},

	getName: function (callback) {
		this.log("getName :", this.name);
		var error = null;
		callback(error, this.name);
	},

	createService: function (service) {
		var newService = null;

		var enableSet = true;
		var statusEmitters = {};
		var actions = {};

		if(service.characteristic) {
			for (var actionName in service.characteristic) {
				actions[actionName] = this.createAction(service.characteristic[actionName]);
			}
		}

		if (typeof Service[service.type] == 'function') {
			newService = new Service[service.type](service.name);

			for (var characteristicIndex in newService.characteristics) 
			{
				var characteristic = newService.characteristics[characteristicIndex];
				var compactName = characteristic.displayName.replace(/\s/g, '');

				var helper = makeHelper(characteristic);
				if(compactName in service.characteristic)
					characteristic.setValue(service.characteristic[compactName]);
				characteristic.on('get', helper.getter.bind(this))
				characteristic.on('set', helper.setter.bind(this));
			}

			for (var characteristicIndex in newService.optionalCharacteristics) 
			{
				var characteristic = newService.optionalCharacteristics[characteristicIndex];
				var compactName = characteristic.displayName.replace(/\s/g, '');

				if ((service.optionCharacteristic instanceof Array) && service.optionCharacteristic.indexOf(compactName) != -1) {
					var helper = makeHelper(characteristic);
					if(compactName in service.characteristic)
						characteristic.setValue(service.characteristic[compactName]);
					characteristic.on('get', helper.getter.bind(this))
					characteristic.on('set', helper.setter.bind(this));

					newService.addCharacteristic(characteristic);
				}
			}
		}

		function makeHelper(characteristic) {
			return {
				getter: function (callback) {
					var actionName = "get" + characteristic.displayName.replace(/\s/g, '');
					var action = actions[actionName];
					var refreshDelay = service.forceRefreshDelay || this.forceRefreshDelay || 0;
					if (refreshDelay == 0 ) { 
						this.getDispatch(function(error, data) {
							enableSet = false;
							characteristic.setValue(data);
							enableSet = true;
							callback(error, data);
						}, action); 
					} else {
						
						if (typeof statusEmitters[actionName] != "undefined") 
							statusEmitters[actionName].interval.clear();

						statusEmitters[actionName] = pollingtoevent(function (done) {
							
							this.getDispatch(done, action);

						}.bind(this), { 
							longpolling: true, 
							interval: refreshDelay * 1000, 
							longpollEventName: actionName 
						});

						statusEmitters[actionName].on(actionName, function (data) 
						{
						    enableSet = false;
							characteristic.setValue(data);
							enableSet = true;
						
							if(callback){
								callback(null, data);
							}
							// just call it once, multiple calls not allowed
							callback = null;
						});

						
					}
				},
				setter: function (value, callback) {
					if(enableSet == false) {
						callback();
					} else {
						var actionName = "set" + characteristic.displayName.replace(/\s/g, '')
						this.debugLog("setDispatch:actionName:value: ", actionName, value); 
						var action = actions[actionName];
						this.setDispatch(value, callback, action);
					}
				}
			};
		}

		return newService;
	},

	getDispatch: function (callback, action) {
		if (!action) {
			callback(null);

		} else if (!action.url) {
			callback(null, action.body);

		} else {
			this.httpRequest(action.url, action.body, action.httpMethod, function(error, response, responseBody) {
				if (error) {
					this.log("Get characteristic value failed: %s", error.message);
					callback(null);
				} else {
					var state = responseBody;
					state = this.applyMappers(action.mappers, state);
					if (state == "inconclusive" && action.inconclusive) {
						this.getDispatch(callback, action.inconclusive);
					} else {
						callback(null, state);
					}
				}
			}.bind(this));
		}
	},

	setDispatch: function (value, callback, action) {
		if (!action || !action.url) {
			callback(null);
		} else {

			var body = action.body;
			var mappedValue = this.applyMappers(action.mappers, value);
			var url = eval('`'+action.url+'`').replace(/{value}/gi, mappedValue);
			if (body) {
				body = eval('`'+body+'`').replace(/{value}/gi, mappedValue);
			}

			this.httpRequest(url, body, action.httpMethod, function(error, response, responseBody) {
				if (error) {
					this.log("Set characteristic value failed: %s", error.message);
					callback(null);
				} else {
					callback(null, value);
				}
			}.bind(this));
		}
},

	getServices: function () {
		var informationService;
		var services = this.services.map(function(m) {
			var svc = this.createService(m);
			if(m.type == "AccessoryInformation") {
				informationService = svc;
			}
			return svc;
		}.bind(this));

		if (!informationService) {
			informationService = new Service.AccessoryInformation();

			informationService
				.setCharacteristic(Characteristic.Manufacturer, "Custom Manufacturer")
				.setCharacteristic(Characteristic.Model, "HTTP Accessory Model")
				.setCharacteristic(Characteristic.SerialNumber, "HTTP Accessory Serial Number")
				.setCharacteristic(Characteristic.FirmwareRevision, "1.0");

			services.unshift(informationService);
		}

		return services;
	}
};
