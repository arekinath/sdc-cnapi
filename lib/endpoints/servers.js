/*!
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints for interacting with compute nodes.
 *
 */

var async = require('async');
var fs = require('fs');
var qs = require('querystring');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var verror = require('verror');

var common = require('../common');
var dapiAlloc = require('dapi/lib/allocator');
var datasetEndpoints = require('./zfs');
var ModelPlatform = require('../models/platform');
var ModelServer = require('../models/server');
var validation = require('../validation/endpoints');

var PROVISIONER = 'provisioner';


function Server() {}


Server.init = function () {
    Server.log = ModelServer.log;
    Server.allocator = new dapiAlloc(ModelServer.log, ['pipe', 'identity']);
};


/* BEGIN JSSTYLED */
/**
 * Returns Servers present in datacenter.
 *
 * @name ServerList
 * @endpoint GET /servers
 * @section Server API
 *
 * @param {String} uuids Comma seperated list of UUIDs to look up
 * @param {Boolean} setup Return only setup servers
 * @param {Boolean} headnode Return only headnodes
 * @param {Boolean} reserved Return only reserved servers
 * @param {Boolean} reservoir Return only reservoir servers
 * @param {String} hostname Return machine with given hostname
 * @param {String} extras Comma seperated values: vms, memory, disk, sysinfo, capacity, all
 * @param {Number} limit Maximum number of results to show
 * @param {Number} offset Offset the subset of results returned
 *
 * @example GET /servers
 * @example GET /servers?uuids=uuid1,uuid2
 * @example GET /servers?setup=true
 * @example GET /servers?headnode=false
 *
 * @response 200 Array The returned servers
 */
/* END JSSTYLED */

Server.list = function (req, res, next) {
    var result;

    var rules = {
        'setup': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'reserved': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'reservoir': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'headnode': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'hostname': ['optional', 'isStringType', 'isTrim'],
        'limit': ['optional', 'isNumberType'],
        'offset': ['optional', 'isNumberType'],
        'uuids': [
            ['optional', undefined],
            /*JSSTYLED*/
            ['regex', RegExp(/^[-a-z0-9A-Z]+(,[-a-z0-9A-Z]+)*$/i)]
        ]
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    async.waterfall([
        function (cb) {
            var options = {};
            options.wantFinal = true;

            options.uuid = req.params.uuids &&
                req.params.uuids.split(new RegExp('\s*,\s*', 'g'));
            options.setup = req.params.setup;
            options.reserved = req.params.reserved;
            options.headnode = req.params.headnode;
            options.reservoir = req.params.reservoir;
            options.hostname = req.params.hostname;
            options.default = false;

            // Set up paging
            ['limit', 'offset'].forEach(function (f) {
                if (req.params.hasOwnProperty(f)) {
                    options[f] = req.params[f];
                }
            });

            // Set up extras
            if (req.params.extras) {
                var extras = { status: true, last_heartbeat: true };
                options.extras = extras;

                req.params.extras.split(',').forEach(function (f) {
                    extras[f] = true;
                });

                // Capacity requires most of the data from CNAPI. Unfortunately,
                // this means we need to clean up the largest additions
                // (sysinfo and vms) later on if they weren't also explicitly
                // requested.
                if (extras.capacity && !extras.all) {
                    var noAll = true;
                    options.extras.all = true;
                }
            }

            req.log.debug(options, 'Searching for all servers');
            ModelServer.list(
                options,
                function (error, s) {
                    if (error) {
                        cb(error);
                        return;
                    }

                    req.log.debug({ servers: s }, 'Servers found');

                    if (!extras || (!extras.all && !extras.sysinfo)) {
                        for (var i in s) {
                            delete s[i].sysinfo;
                        }
                    }

                    if (extras && (extras.capacity || extras.all)) {
                        req.log.debug('Running capacity');

                        // this mutates s, adding unreserved_cpu, unreserved_ram
                        // and unreserved_disk to eligible servers
                        Server.allocator.serverCapacity(s);

                        req.log.debug('Done running capacity');

                        if (noAll) {
                            // if noAll is true, we know options.extras exists
                            if (!extras.vms) {
                                for (i in s) {
                                    delete s[i].vms;
                                }
                            }

                            if (!extras.sysinfo) {
                                for (i in s) {
                                    delete s[i].sysinfo;
                                }
                            }
                        }
                    }

                    result = s;
                    cb();
                    return;
                });
        }
    ],
    function (error) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }

        res.send(result);
        next();
        return;
    });
};


/* BEGIN JSSTYLED */
/**
 * Look up a single Server by UUID.
 *
 * @name ServerGet
 * @endpoint GET /servers/:server\_uuid
 * @section Server API
 *
 * @example GET /servers/12494d5e-3960-4d65-a61a-0ca6252d6914
 *
 * @response 200 Object The server object>
 */
/* END JSSTYLED */

Server.get = function (req, res, next) {
    req.stash.server.getFinal(
        function (error, server) {
            req.log.debug('Running capacity');
            // this mutates server, adding unreserved_cpu, unreserved_ram and
            // unreserved_disk to eligible servers
            Server.allocator.serverCapacity([server]);
            req.log.debug('Done running capacity');

            res.send(server);
            next();
        });
};


/* BEGIN JSSTYLED */
/**
 * Set the value of a Server's attribute.
 *
 * @name ServerUpdate
 * @endpoint POST /servers/:server_uuid
 * @section Server API
 *
 * @param {String} boot_platform The platform image to be used on next boot
 * @param {String} default_console Console type
 * @param {String} rack_identifier The id of the server's rack
 * @param {String} comments Any comments about the server
 * @param {Boolean} reserved Server is available for provisioning
 * @param {Boolean} reservoir Server should be considered last for provisioning
 * @param {Nmber} reservation_ratio The reservation ratio
 * @param {Object} overprovision_ratios The overprovisioning ratios. Must be an object with Number value keys and keys must be one of 'cpu', 'ram', 'disk', 'io', 'net'.
 * @param {String} serial Serial device
 * @param {Boolean} setup True if server has been set up
 * @param {Boolean} setting_up True if server is in the process of setting up
 * @param {String} transitional_status The fallback status if not 'running'. For example, if the server has to reboot, this value may be set to 'rebooting'.
 * @param {Object} traits Server traits
 *
 * @example POST /servers/12494d5e-3960-4d65-a61a
 *          -d '{ "default_console": "vga", "setup", true }'
 *
 * @response 204 None The value was set successfuly
 */
/* END JSSTYLED */

Server.update = function (req, res, next) {
    var rules = {
        'boot_params': ['optional', 'isObjectType'],
        'boot_platform': ['optional', 'isStringType', 'isTrim'],
        'comments': ['optional', 'isStringType', 'isTrim'],
        'default_console': ['optional', 'isStringType', 'isTrim'],
        'datacenter': ['optional', 'isStringType', 'isTrim'],
        'nics': ['optional', 'isArrayType'],
        'overprovision_ratios': ['optional', 'isObjectType'],
        'rack_identifier': ['optional', 'isStringType', 'isTrim'],
        'reservation_ratio': ['optional', 'isNumberType'],
        'reserved': ['optional', 'isBooleanType'],
        'reservoir': ['optional', 'isBooleanType'],
        'serial': ['optional', 'isStringType', 'isTrim'],
        'setting_up': ['optional', 'isBooleanType'],
        'setup': ['optional', 'isBooleanType'],
        'traits': ['optional', 'isObjectType'],
        'transitional_status': ['optional', 'isStringType', 'isTrim']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    if (req.params.overprovision_ratios) {
        Object.keys(req.params.overprovision_ratios).forEach(function (key) {
            if ([ 'cpu', 'ram', 'disk', 'io', 'net'].indexOf(key) === -1) {
                next(new restify.InvalidArgumentError(
                    'Invalid key %s', key));
            }
            if (typeof (req.params.overprovision_ratios[key]) !== 'number') {
                next(new restify.InvalidArgumentError(
                    'Invalid type for %s', key));
                return;
            }
            if (req.params.overprovision_ratios[key] < 0) {
                next(new restify.InvalidArgumentError(
                    'Invalid value for %s', key));
                return;
            }
        });

        req.params.overprovision_ratios
            = qs.stringify(req.params.overprovision_ratios);
    }

    var attrs = [
        ['boot_params', Object],
        ['boot_platform', String],
        ['comments', String],
        ['default_console', String],
        ['datacenter', String],
        ['overprovision_ratios', Object],
        ['rack_identifier', String],
        ['reservation_ratio', Number],
        ['reserved', Boolean],
        ['reservoir', Boolean],
        ['serial', String],
        ['setting_up', Boolean],
        ['setup', Boolean],
        ['traits', Object],
        ['transitional_status', String]
    ];

    var change = {};

    attrs.forEach(function (i) {
        var param = i[0];
        var type =  i[1];
        var val = req.params[param];

        if (typeof (val) === 'undefined') {
            return;
        }

        if (type == String) {
            change[param] = val;
        } else if (type == Boolean) {
            if (val === true) {
                change[param] = true;
            } else if (val === false) {
                change[param] = false;
            }
        } else if (type == Number) {
            change[param] = Number(val);
        } else {
            change[param] = val;
        }
    });

    async.waterfall([
        // If specified, ensure the boot_platform exists as a platform image on
        // the headnode.
        function (cb) {
            if (!change.boot_platform) {
                cb();
                return;
            }

            ModelPlatform.list({}, function (error, platforms) {
                if (error) {
                    cb(error);
                    return;
                }

                if (!platforms.hasOwnProperty(change.boot_platform)) {
                    cb(new verror.VError('failed to find given platform image,'
                        + ' %s', change.boot_platform));
                    return;
                }

                cb();
            });
        },

        // If modifying overprovision ratio, ensure the Server has no Vms
        function (cb) {
            if (!change.overprovision_ratios) {
                cb();
                return;
            }

            req.stash.server.getRaw(function (error, server) {
                if (error) {
                    cb(new verror.VError('failed to fetch vms'));
                    return;
                }

                if (server.vms && Object.keys(server.vms).length) {
                    var err = new verror.VError(
                        'overprovision_ratio may not be changed'
                        + ' if compute node has vms');
                    err.code = 409;

                    cb(err);
                    return;
                }

                cb();
            });
        },
        // If the server is not setup, we don't need to bother updating the
        // on-server configturation value.
        function (cb) {
            if (!req.params.overprovision_ratios) {
                cb();
                return;
            }

            req.stash.server.getRaw(function (error, raw) {
                if (!raw.setup) {
                    cb();
                    return;
                }

                var request = {
                    task: 'server_overprovision_ratio',
                    cb: function (err, task) {
                    },
                    evcb: function () {},
                    synccb: function (err, result) {
                        cb(err, result);
                    },
                    params: { value: req.params.overprovision_ratios  }
                };

                req.stash.server.sendTaskRequest(request);
            });
        }
    ],
    function (error) {
        if (error) {
            if (error.code) {
                next(
                    restify.codeToHttpError(error.code, error.message));
                return;
            }

            next(
                new restify.InternalError(error.message));
            return;
        }

        req.stash.server.modify(
            change,
            function (modifyError) {
                if (modifyError) {
                    next(new restify.InternalError(error.message));
                    return;
                }

                res.send(204);
                next();
                return;
            });
        });
};

/* BEGIN JSSTYLED */
/**
 * Reboot the server.
 *
 * @name ServerReboot
 * @endpoint POST /servers/:server\_uuid/reboot
 * @section Server API
 *
 * @response 204 Object Server reboot initiated
 * @response 500 None Error attempting to set up server
 */
/* END JSSTYLED */

Server.reboot = function (req, res, next) {
    req.stash.server.getRaw(function (error, rawserver) {
        var params = {
            origin: req.params.origin,
            creator_uuid: req.params.creator_uuid
        };
        req.stash.server.reboot(params, function (rebootError, jobUuid) {
            if (rebootError) {
                next(new restify.InternalError(rebootError.message));
                return;
            }
            res.send(202, { job_uuid: jobUuid });
            next();
            return;
        });
    });
};

/* BEGIN JSSTYLED */
/**
 * Reset the server back to a factory state.
 *
 * @name ServerFactoryReset
 * @endpoint PUT /servers/:server\_uuid/factory-reset
 * @section Server API
 *
 * @response 204 Object Setup initated, returns object containing workflow id
 * @response 500 None Error attempting to set up server
 */
/* END JSSTYLED */

Server.factoryReset = function (req, res, next) {
    var server = req.stash.server.getValue();
    var vms = server.vms;

    if (vms && Object.keys(vms).length) {
        res.send(
            409, 'Server may not be reset because it has ' +
            Object.keys(vms).length +
            ' vms');
        next();
        return;
    } else {
        req.log.info(
            '%s had no VMs prior to factory-reset. Continuing.',
            req.stash.server.uuid);
    }


    req.stash.server.factoryReset({
        origin: req.params.origin,
        creator_uuid: req.params.creator_uuid
    },
    function (resetError, jobUuid) {
        if (resetError) {
            next(new restify.InternalError(resetError.message));
            return;
        }

        res.send(202, { job_uuid: jobUuid });
        next();
    });
};


/* BEGIN JSSTYLED */
/**
 * Initiate the server setup process for a newly started server.
 *
 * @name ServerSetup
 * @endpoint PUT /servers/:server_uuid/setup
 * @section Server API
 * @param {Object} nics Nic parameters to update
 * @param {String} postsetup_script Script to run after setup has completed
 * @param {String} hostname Hostname to set for the specified server
 * @response 200 Object Setup initated, returns object containing workflow id
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */

Server.setup = function (req, res, next) {
    var rules = {
        'nics': ['optional', 'isArrayType'],
        'postsetup_script': ['optional', 'isStringType'],
        'hostname': ['optional', 'isStringType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var params = {};
    if (req.params.hasOwnProperty('nics')) {
        params.nics = req.params.nics;
    }

    if (req.params.hasOwnProperty('postsetup_script')) {
        params.postsetup_script = req.params.postsetup_script;
    }
    if (req.params.hasOwnProperty('hostname')) {
        params.hostname = req.params.hostname;
    }
    if (req.params.hasOwnProperty('origin')) {
        params.origin = req.params.origin;
    }
    if (req.params.hasOwnProperty('creator_uuid')) {
        params.creator_uuid = req.params.creator_uuid;
    }
    req.stash.server.getRaw(function (error, rawserver) {
        if (rawserver.setup) {
            res.send(204);
            next();
            return;
        }

        req.stash.server.setup(params, function (setupError, jobUuid) {
            if (setupError) {
                next(
                    new restify.InternalError(
                        setupError.message));
                return;
            }
            res.send(202, { job_uuid: jobUuid });
            next();
            return;
        });
    });
};


/* BEGIN JSSTYLED */
/**
 * Fetch a given server's sysinfo values and store them in the server object.
 *
 * @name ServerSysinfoRefresh
 * @endpoint POST /servers/:server_uuid/sysinfo-refresh
 * @section Server API
 *
 * @response 200 Object Sysinfo refresh initiated
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */

Server.sysinfoRefresh = function (req, res, next) {
    req.log.info(
        'Querying Ur agent on %s for server for sysinfo',
        req.params.server_uuid);
    ModelServer.getUr().serverSysinfo(
        req.params.server_uuid,
        {},
        function (sysinfoerror, sysinfo) {
            if (sysinfoerror) {
                next(
                    new restify.InternalError(
                        sysinfoerror.message));
                return;
            }

            req.log.info({ sysinfo: sysinfo }, 'Received sysinfo');

            req.stash.server.getRaw(function (geterror, server) {
                if (geterror) {
                    next(
                        new restify.InternalError(
                            geterror.message));
                    return;
                }
                server.sysinfo = sysinfo;

                // Start workflow with new sysinfo
                ModelServer.getWorkflow().getClient().createJob(
                    'server-sysinfo',
                    {
                        sysinfo: sysinfo,
                        server_uuid: req.params.server_uuid,
                        target: req.params.server_uuid,
                        admin_uuid: ModelServer.getConfig().adminUuid
                    },
                    function (error, job) {
                        if (error) {
                            req.log.error(error, 'error in workflow');
                            return;
                        }
                    });

                req.log.info('Writing new sysinfo to moray');

                req.stash.server.modify(server, function (moderror) {
                    if (moderror) {
                        next(
                            new restify.InternalError(
                                moderror.message));
                        return;
                    }
                    req.log.info('Successfully modified sysinfo in moray');
                    res.send(204);
                    next();
                });
            });
    });
};

/* BEGIN JSSTYLED */
/**
 * Remove all references to given server. Does not change anything on the
 * actual server.
 *
 * @name ServerDelete
 * @endpoint DELETE /servers/:server_uuid
 * @section Server API
 *
 * @response 204 None Server was deleted successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

Server.del = function (req, res, next) {
    req.stash.server.del(function (error) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }
        res.send(200);
        next();
    });
};


/* BEGIN JSSTYLED */
/**
 * Return details of all provisioner tasks run on the compute node since
 * provisioner was started.
 *
 * @name ServerTaskHistory
 * @endpoint GET /servers/:server_uuid/task-history
 * @section Server API
 *
 * @response 204 None Tasks returned successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

Server.taskHistory = function (req, res, next) {
    var self = this;
    var server = req.stash.server;

    function callback(error, msg) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }
        res.send(msg);
        next();
        return;
    }

    var request = {
        task: 'show_tasks',
        cb: function (error, task) {
        },
        evcb: function () {},
        synccb: function (error, result) {
            callback(error, result);
        },
        params: { uuid: self.uuid }
    };

    server.sendTaskRequest(request);
};

Server.eventHeartbeat = function (req, res, next) {
    ModelServer.getApp().onHeartbeat(
        req.params.server_uuid,
        function (err) {
            if (err) {
                req.log.error({ error: err }, 'processing heartbeat');
                next(
                    new restify.InternalError(err.message));
                return;
            }
            res.send(204);
            next();
        });
};

Server.eventVmsUpdate = function (req, res, next) {
    ModelServer.getApp().onVmsUpdate(
        req.params.server_uuid, req.params,
        function (err) {
            if (err) {
                req.log.error({ error: err }, 'processing heartbeat');
                next(
                    new restify.InternalError(err.message));
                return;
            }
            res.send(204);
            next();
        });
};

/**
 * Check if an image has been imported into the compute node, and if it hasn't
 * go ahead and import it.
 */

Server.ensureImage = function (req, res, next) {
    var self = this;

    req.stash.server.sendTaskRequest({
        task: 'image_ensure_present',
        params: req.params,
        req: req,
        evcb: ModelServer.createProvisionerEventHandler(self, req.params.jobid),
        cb: function (error, task) {
            res.send({ id: task.id });
            next();
            return;
        }});
};


Server.nop = function Server$nop(req, res, next) {
    req.params.sleep = 0;
    req.stash.server.sendHttpTask({
        task: 'nop',
        params: req.params,
        req: req,
        cb: function (error, taskstatus) {
            res.send({ id: taskstatus.id });
            next();
        }
    });
};


function attachTo(http, app) {
    Server.init();

    var ensure = require('../endpoints').ensure;

    // List servers
    http.get(
        { path: '/servers', name: 'ServerList' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            connected: ['moray']
        }),
        Server.list);

    // Get server
    http.get(
        { path: '/servers/:server_uuid', name: 'ServerGet' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.get);

    // Update server
    http.post(
        { path: '/servers/:server_uuid', name: 'ServerUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray', 'workflow']
        }),
        Server.update);

    // Setup server
    http.put(
        { path: '/servers/:server_uuid/setup', name: 'ServerSetup' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'workflow']
        }),
        Server.setup);

    // Reboot server
    http.post(
        { path: '/servers/:server_uuid/reboot', name: 'ServerReboot' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'workflow']
        }),
        Server.reboot);

    // Delete server
    http.del(
        { path: '/servers/:server_uuid', name: 'ServerDelete' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'workflow']
        }),
        Server.del);

    // Import an image to the server
    http.post({
        path: '/servers/:server_uuid/ensure-image',
        name: 'ServerEnsureImage' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray']
        }),
        Server.ensureImage);

    // Refresh server sysinfo
    http.post({
        path: '/servers/:server_uuid/sysinfo-refresh',
        name: 'ServerSysinfoRefresh' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'workflow']
        }),
        Server.sysinfoRefresh);

    // Factory-reset server
    http.put({
        path: '/servers/:server_uuid/factory-reset',
        name: 'ServerFactoryReset' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'workflow']
        }),
        Server.factoryReset);

    // Provisioner task history
    http.get({
        path: '/servers/:server_uuid/task-history',
        name: 'ServerTaskHistory' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray']
        }),
        Server.taskHistory);

    http.post({
        path: '/servers/:server_uuid/events/heartbeat',
        name: 'ServerEventHeartbeat' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: [],
            connected: []
        }),
        Server.eventHeartbeat);

    http.post({
        path: '/servers/:server_uuid/events/status',
        name: 'ServerEventVmsUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: [],
            connected: []
        }),
        Server.eventVmsUpdate);

    /**
     *
     * Misc
     *
     */

    // No-op task
    http.post(
        { path: '/servers/:server_uuid/nop', name: 'DoNop' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray']
        }),
        Server.nop);
}


exports.attachTo = attachTo;
