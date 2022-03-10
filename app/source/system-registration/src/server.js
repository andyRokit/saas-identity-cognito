'use strict';

// Declare library dependencies
const express = require('express');
const bodyParser = require('body-parser');
const uuidV4 = require('uuid/v4');

const AxiosLogger = require('axios-logger');
const BadRequestError = require('bad-request-error');

// Init axios
const axios = require('axios').create();
axios.interceptors.request.use(AxiosLogger.requestLogger);
axios.interceptors.response.use(AxiosLogger.responseLogger);

//Configure Environment
const configModule = require('../shared-modules/config-helper/config.js');
const configuration = configModule.configure(process.env.NODE_ENV);

//Configure Logging
const winston = require('winston');

// Init the winston logger
const logger = winston.createLogger({
    level: configuration.loglevel,
    format: winston.format.simple(),
    transports: [
        new winston.transports.Console()
    ]
});

const tenantURL = configuration.url.tenant;
const userURL = configuration.url.user;
const registerTenantUserURL = userURL + '/system';
const deleteInfraUrl = configuration.url.user + '/tenants';
const deleteTableUrl = configuration.url.user + '/tables';


// Instantiate application
var app = express();

// Configure middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));
app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
    res.header("Access-Control-Allow-Headers", "Content-Type, Origin, X-Amz-Date, Authorization, X-Api-Key, X-Amz-Security-Token, Access-Control-Allow-Headers, X-Requested-With, Access-Control-Allow-Origin");
    // intercept OPTIONS method
    if ('OPTIONS' == req.method) {
        res.send(200);
    }
    else {
        next();
    }
});


/**
 * Register a new system admin user
 */
app.post('/sys/admin', async (req, res, next) => {
    var tenant = req.body;

    // Generate the tenant id for the system user
    tenant.id = 'SYSADMIN' + uuidV4();
    logger.debug('Creating system admin user, tenant id: ' + tenant.id);
    tenant.id = tenant.id.split('-').join('');

    await verifyUserDoesntExist(tenant)
        .then(() => registerTenantAdmin(tenant))
        .then(registeredTenant => saveTenantData(registeredTenant))
        .then(() => res.status(200).send(`System admin user ${tenant.id} registered`))
        .catch(err => next(err));
});


/**
 * Delete all system infrastructure and tables.
 */
app.delete('/sys/admin', function (req, res) {


    deleteInfra()
        .then(function () {
            logger.debug("Delete Infra");
            //CloudFormation will remove the tables. This can be uncommented if required.
            //deleteTables()
        })
        .then(function () {
            logger.debug("System Infrastructure & Tables removed");
            res.status(200).send("System Infrastructure & Tables removed");
        })
        .catch(function (error) {
            logger.error("Error removing system");
            res.status(400).send(" Error removing system");
        });

});

// Error handling
app.use((err, req, res, next) => {
    // send errmsg to user if it's a BadRequestError
    if (res && err.name && err.name === 'BadRequestError') {
        res.status(err.httpStatus).json({ error: err.message });
        return;
    }

    // send http err if res object is provided
    if (res) res.status(500).send('Server Error');

    // if it's more low level, or if errorField isn't an error's propt
    logger.error(err.stack);
})


/**
 * Determine if a system admin user can be created (they may already exist)
 * @param tenant The tenant data
 * @returns True if the tenant exists
 */
function verifyUserDoesntExist(tenant) {
    logger.debug(`Checking tenant exists: ${tenant.userName}`);

    // Create URL for user-manager request
    const url = userURL + '/pool/' + tenant.userName;

    return axios
        .get(url)
        .then(res => {
            if(res.data.userName === tenant.userName) {
                throw new BadRequestError(`Admin user ${tenant.userName} already exists`);
            }
        }).catch(err => {
            if (err.response?.data?.Error === "User not found") {
                // Happy path!  This is actually the response we want.  Swallow err and return.
                return;
            } else if (err.response?.data) {
                throw new Error(`Failed to check if tenant ${tenant.userName} exists. Status: ${err.response.status} Body: ${err.response.body}`)
            } else {
                throw new Error(`Failed to check if tenant ${tenant.userName} exists. Error: ${err.message}`)
            }
        });
};

/**
 * Register a new tenant user and provision policies for that user
 * @param tenant The new tenant data
 * @returns {Promise} Results of tenant provisioning
 */
function registerTenantAdmin(tenant) {
    logger.debug("Registering tenant admin: " + tenant.userName);

    return axios.post(registerTenantUserURL, {
        "tenant_id": tenant.id,
        "companyName": tenant.companyName,
        "accountName": tenant.accountName,
        "ownerName": tenant.ownerName,
        "tier": tenant.tier,
        "email": tenant.email,
        "userName": tenant.userName,
        "role": tenant.role,
        "firstName": tenant.firstName,
        "lastName": tenant.lastName
    }).then(res => {
        const pool = res.data.pool;
        const identityPool = res.data.identityPool;
        const role = res.data.role;
        const policy = res.data.policy;

        //Adding Data to the Tenant Object that will be required to cleaning up all created resources for all tenants.
        tenant.UserPoolId = pool.UserPool.Id;
        tenant.IdentityPoolId = identityPool.IdentityPoolId;

        tenant.systemAdminRole = role.systemAdminRole;
        tenant.systemSupportRole = role.systemSupportRole;
        tenant.trustRole = role.trustRole;

        tenant.systemAdminPolicy = policy.systemAdminPolicy;
        tenant.systemSupportPolicy = policy.systemSupportPolicy;
        return tenant;
    }).catch(err => {
        throw new Error(`Error registering new system admin user: ${err.message}`);
    });
}

/**
 * Save the configuration and status of the new tenant
 * @param tenant Data for the tenant to be created
 * @returns {Promise} The created tenant
 */
function saveTenantData(tenant) {
    logger.info('saveTenantData saving ' + tenant.id);

    return axios.post(tenantURL,
        {
            "id": tenant.id,
            "companyName": tenant.companyName,
            "accountName": tenant.accountName,
            "ownerName": tenant.ownerName,
            "tier": tenant.tier,
            "email": tenant.email,
            "status": "Active",
            "UserPoolId": tenant.UserPoolId,
            "IdentityPoolId": tenant.IdentityPoolId,
            "systemAdminRole": tenant.systemAdminRole,
            "systemSupportRole": tenant.systemSupportRole,
            "trustRole": tenant.trustRole,
            "systemAdminPolicy": tenant.systemAdminPolicy,
            "systemSupportPolicy": tenant.systemSupportPolicy,
            "userName": tenant.userName,
        }
    ).catch(err => {
        throw new Error(`Failed to save tenant data.  Error: ${err.message}`);
    });
}

/**
 * Delete the User Pools, Identity Pools, Roles, and Policies for all Tenants, and the System Admin.
 * @returns {Promise} The created tenant
 */
function deleteInfra() {
    return axios
        .delete(deleteInfraUrl)
        .then(res => {
            logger.info('Removed Infrastructure');
        })
        .catch(err => {
            logger.info(`Error Removing Infrastructure: ${err.message}`);
        });
}

/**
 * Delete all DynamoDB Tables.
 * @returns {Promise} The created tenant
 */
function deleteTables() {
    return axios
        .delete(deleteTableUrl)
        .then(res => {
            logger.info('Removed Tables');
        })
        .catch(err => {
            logger.info(`Error Removing Tables: ${err.message}`);
        });
}


app.get('/sys/health', function (req, res) {
    res.status(200).send({ service: 'System Registration', isAlive: true });
});


// Start the servers
app.listen(configuration.port.sys);
console.log(configuration.name.sys + ' service started on port ' + configuration.port.sys);
