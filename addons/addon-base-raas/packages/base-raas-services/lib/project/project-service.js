/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License").
 *  You may not use this file except in compliance with the License.
 *  A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 *  or in the "license" file accompanying this file. This file is distributed
 *  on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 *  express or implied. See the License for the specific language governing
 *  permissions and limitations under the License.
 */

const _ = require('lodash');
const Service = require('@aws-ee/base-services-container/lib/service');
const { runAndCatch } = require('@aws-ee/base-services/lib/helpers/utils');
const { allowIfActive, allowIfAdmin } = require('@aws-ee/base-services/lib/authorization/authorization-utils');
const { getSystemRequestContext } = require('@aws-ee/base-services/lib/helpers/system-context');

const { isExternalGuest, isExternalResearcher, isInternalGuest, isAdmin, isSystem } = require('../helpers/is-role');
const createSchema = require('../schema/create-project');
const updateSchema = require('../schema/update-project');

const settingKeys = {
  tableName: 'dbProjects',
  environmentTableName: 'dbEnvironments',
  isAppStreamEnabled: 'isAppStreamEnabled',
};

class ProjectService extends Service {
  constructor() {
    super();
    this.dependency([
      'jsonSchemaValidationService',
      'authorizationService',
      'dbService',
      'auditWriterService',
      'userService',
      'awsAccountsService',
      'indexesService',
    ]);
  }

  async init() {
    await super.init();
    const [dbService] = await this.service(['dbService']);
    const table = this.settings.get(settingKeys.tableName);
    this.userService = await this.service('userService');
    this.isAppStreamEnabled = this.settings.getBoolean(settingKeys.isAppStreamEnabled);

    this._getter = () => dbService.helper.getter().table(table);
    this._updater = () => dbService.helper.updater().table(table);
    this._query = () => dbService.helper.query().table(table);
    this._deleter = () => dbService.helper.deleter().table(table);
    this._scanner = () => dbService.helper.scanner().table(table);
  }

  async find(requestContext, { id, fields = [] }) {
    const restrict =
      isExternalGuest(requestContext) || isExternalResearcher(requestContext) || isInternalGuest(requestContext);

    if (restrict) return undefined;

    // Throw unauthorized error if the user is not associated with this project, unless they are admin
    if (
      !isAdmin(requestContext) &&
      !isSystem(requestContext) &&
      !(await this.verifyUserProjectAssociation(_.get(requestContext, 'principalIdentifier.uid'), id))
    )
      throw this.boom.forbidden(`You're not authorized to access project "${id}"`, true);

    let result = await this._getter()
      .key({ id })
      .projection(fields)
      .get();

    if (this.isAppStreamEnabled) {
      result = await this.updateWithAppStreamConfig(result);
    }

    return this._fromDbToDataObject(result);
  }

  async mustFind(requestContext, { id, fields = [] }) {
    const result = await this.find(requestContext, { id, fields });
    if (!result) throw this.boom.notFound(`project with id "${id}" does not exist`, true);
    return result;
  }

  async create(requestContext, rawData) {
    // ensure that the caller has permissions to create the index
    // Perform default condition checks to make sure the user is active and is admin
    await this.assertAuthorized(
      requestContext,
      { action: 'create', conditions: [allowIfActive, allowIfAdmin] },
      rawData,
    );

    // Validate input
    const [validationService] = await this.service(['jsonSchemaValidationService']);
    await validationService.ensureValid(rawData, createSchema);

    // For now, we assume that 'createdBy' and 'updatedBy' are always users and not groups
    const by = _.get(requestContext, 'principalIdentifier.uid');
    const id = rawData.id;

    // Prepare the db object
    const dbObject = this._fromRawToDbObject(rawData, { rev: 0, createdBy: by, updatedBy: by });

    // Time to save the the db object
    const result = await runAndCatch(
      async () => {
        return this._updater()
          .condition('attribute_not_exists(id)') // yes we need this
          .key({ id })
          .item(dbObject)
          .update();
      },
      async () => {
        throw this.boom.badRequest(`project with id "${id}" already exists`, true);
      },
    );

    // Write audit event
    await this.audit(requestContext, { action: 'create-project', body: result });

    return result;
  }

  async update(requestContext, rawData) {
    // ensure that the caller has permissions to update the index
    // Perform default condition checks to make sure the user is active and is admin
    await this.assertAuthorized(
      requestContext,
      { action: 'update', conditions: [allowIfActive, allowIfAdmin] },
      rawData,
    );

    // Validate input
    const [validationService] = await this.service(['jsonSchemaValidationService']);
    await validationService.ensureValid(rawData, updateSchema);

    // For now, we assume that 'updatedBy' is always a user and not a group
    const by = _.get(requestContext, 'principalIdentifier.uid');
    const { id, rev } = rawData;

    // Prepare the db object
    const dbObject = _.omit(this._fromRawToDbObject(rawData, { updatedBy: by }), ['rev']);

    // Time to save the the db object
    const result = await runAndCatch(
      async () => {
        return this._updater()
          .condition('attribute_exists(id)') // yes we need this
          .key({ id })
          .rev(rev)
          .item(dbObject)
          .update();
      },
      async () => {
        // There are two scenarios here:
        // 1 - The project does not exist
        // 2 - The "rev" does not match
        // We will display the appropriate error message accordingly
        const existing = await this.find(requestContext, { id, fields: ['id', 'updatedBy'] });
        if (existing) {
          throw this.boom.badRequest(
            `project information changed just before your request is processed, please try again`,
            true,
          );
        }
        throw this.boom.notFound(`project with id "${id}" does not exist`, true);
      },
    );

    // Write audit event
    await this.audit(requestContext, { action: 'update-project', body: result });

    return result;
  }

  async delete(requestContext, { id }) {
    // ensure that the caller has permissions to delete the index
    // Perform default condition checks to make sure the user is active and is admin
    await this.assertAuthorized(
      requestContext,
      { action: 'delete', conditions: [allowIfActive, allowIfAdmin] },
      { id },
    );

    // ensure that the project is not linked to any active environments
    const [dbService] = await this.service(['dbService']);
    const environmentsTable = this.settings.get(settingKeys.environmentTableName);
    const scanner = () => dbService.helper.scanner().table(environmentsTable);
    const environments = await scanner().scan();
    if (environments.some(env => env.id === id)) {
      throw this.boom.badRequest(`Deletion could not be completed. Project is linked to existing resources`, true);
    }

    // Lets now remove the item from the database
    const result = await runAndCatch(
      async () => {
        return this._deleter()
          .condition('attribute_exists(id)') // yes we need this
          .key({ id })
          .delete();
      },
      async () => {
        throw this.boom.notFound(`project with id "${id}" does not exist`, true);
      },
    );

    // Write audit event
    await this.audit(requestContext, { action: 'delete-project', body: { id } });

    return result;
  }

  async list(requestContext, { fields = [] } = {}) {
    const restrict =
      isExternalGuest(requestContext) || isExternalResearcher(requestContext) || isInternalGuest(requestContext);

    if (restrict) return [];

    // Remember doing a scan is not a good idea if you billions of rows
    let projects = await this._scanner()
      .limit(1000)
      .projection(fields)
      .scan();

    if (this.isAppStreamEnabled) {
      projects = await this.updateWithAppStreamConfig(projects);
    }

    // Only return projects that the user has been associated with unless user is an admin
    if (isAdmin(requestContext) || isSystem(requestContext)) return projects;

    const by = _.get(requestContext, 'principalIdentifier.uid');
    const retVal = await Promise.all(
      _.map(projects, async proj => {
        if (await this.verifyUserProjectAssociation(by, proj.id)) return proj;
        return undefined;
      }),
    );
    return _.filter(retVal, val => !_.isUndefined(val));
  }

  /**
   * Returns the same object type as the input with an added isAppStreamConfigured boolean flag for each project entity
   *
   * IMPORTANT: The system context is used instead of the user's request context.
   * This is because non-admin users do not have access to resources like indexes and awsAccounts,
   * which are required for config verification. No other information from these resources are made available to non-admins
   *
   * @param input The Project entity, or list of Project entities
   */
  async updateWithAppStreamConfig(input) {
    try {
      const systemContext = getSystemRequestContext();
      const [awsAccountsService, indexesService] = await this.service(['awsAccountsService', 'indexesService']);
      const accounts = await awsAccountsService.list(systemContext, {
        fields: ['id', 'appStreamFleetName', 'appStreamSecurityGroupId', 'appStreamStackName'],
      });
      const indexes = await indexesService.list(systemContext, { fieldsToGet: ['id', 'awsAccountId'] });
      const accountIdsWithAppStream = _.map(
        _.filter(
          accounts,
          account =>
            !_.isUndefined(account.appStreamFleetName) &&
            !_.isUndefined(account.appStreamSecurityGroupId) &&
            !_.isUndefined(account.appStreamStackName),
        ),
        'id',
      );
      const indexIdsWithAppStream = _.map(
        _.filter(indexes, index => _.includes(accountIdsWithAppStream, index.awsAccountId)),
        'id',
      );

      if (_.isArray(input)) {
        return _.map(input, project => {
          project.isAppStreamConfigured = _.includes(indexIdsWithAppStream, project.indexId);
          return project;
        });
      }

      const project = input;
      project.isAppStreamConfigured = _.includes(indexIdsWithAppStream, project.indexId);
      return project;
    } catch (err) {
      throw this.boom.badRequest(`There was an error filtering AppStream projects: ${err}`, true);
    }
  }

  /**
   * Check if user is associated with the project
   */
  async verifyUserProjectAssociation(uid, projectId) {
    const user = await this.userService.mustFindUser({ uid });
    if (user.projectId.includes(projectId)) {
      return true;
    }
    return false;
  }

  // Do some properties renaming to prepare the object to be saved in the database
  _fromRawToDbObject(rawObject, overridingProps = {}) {
    const dbObject = { ...rawObject, ...overridingProps };
    return dbObject;
  }

  // Do some properties renaming to restore the object that was saved in the database
  _fromDbToDataObject(rawDb, overridingProps = {}) {
    if (_.isNil(rawDb)) return rawDb; // important, leave this if statement here, otherwise, your update methods won't work correctly
    if (!_.isObject(rawDb)) return rawDb;

    const dataObject = { ...rawDb, ...overridingProps };
    return dataObject;
  }

  async assertAuthorized(requestContext, { action, conditions }, ...args) {
    const authorizationService = await this.service('authorizationService');

    // The "authorizationService.assertAuthorized" below will evaluate permissions by calling the "conditions" functions first
    // It will then give a chance to all registered plugins (if any) to perform their authorization.
    // The plugins can even override the authorization decision returned by the conditions
    // See "authorizationService.authorize" method for more details
    await authorizationService.assertAuthorized(
      requestContext,
      { extensionPoint: 'project-authz', action, conditions },
      ...args,
    );
  }

  async audit(requestContext, auditEvent) {
    const auditWriterService = await this.service('auditWriterService');
    // Calling "writeAndForget" instead of "write" to allow main call to continue without waiting for audit logging
    // and not fail main call if audit writing fails for some reason
    // If the main call also needs to fail in case writing to any audit destination fails then switch to "write" method as follows
    // return auditWriterService.write(requestContext, auditEvent);
    return auditWriterService.writeAndForget(requestContext, auditEvent);
  }
}

module.exports = ProjectService;
