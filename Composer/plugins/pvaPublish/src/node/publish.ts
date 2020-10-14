import { IBotProject } from '@bfc/shared';
import { join } from 'path';
import { createReadStream, createWriteStream } from 'fs';
import fetch from 'node-fetch';

import {
  PVAPublishJob,
  PublishConfig,
  PublishResponse,
  PublishResult,
  UserIdentity,
  PublishState,
  PublishHistory,
} from './types';

const API_VERSION = '1';
//const BASE_URL = `https://powerva.microsoft.com/api/botmanagement/v${API_VERSION}`; // prod / sdf
const BASE_URL = `https://bots.int.customercareintelligence.net/api/botmanagement/v${API_VERSION}`; // int / ppe
const authCredentials = {
  clientId: 'ce48853e-0605-4f77-8746-d70ac63cc6bc',
  scopes: ['a522f059-bb65-47c0-8934-7db6e5286414/.default'], // int / ppe
};

// in-memory history that allows us to get the status of the most recent job
const publishHistory: PublishHistory = {};

export const publish = async (
  config: PublishConfig,
  project: IBotProject,
  metadata: any,
  _user: UserIdentity,
  { getAccessToken, loginAndGetIdToken }
): Promise<PublishResponse> => {
  const {
    // these are provided by Composer
    profileName, // the name of the publishing profile "My PVA Prod Slot"

    // these are specific to the PVA publish profile shape
    botId,
    envId,
    tenantId,
    deleteMissingComponents, // publish behavior
  } = config;
  const { comment = '' } = metadata;

  try {
    // authenticate with PVA
    const idToken = await loginAndGetIdToken(authCredentials);
    const accessToken = await getAccessToken({ ...authCredentials, idToken });

    // where we will store the bot .zip
    const zipPath = join(__dirname, 'bot.zip');

    console.log('writing bot zip to :', zipPath);
    // write the .zip to disk
    const zipWriteStream = createWriteStream(zipPath);
    await new Promise((resolve, reject) => {
      project.exportToZip((archive: NodeJS.ReadStream & { finalize: () => void; on: (ev, listener) => void }) => {
        archive.on('error', (err) => {
          console.error('Got error trying to export to zip: ', err);
          reject(err.message);
        });
        archive.pipe(zipWriteStream);
        archive.on('end', () => {
          archive.unpipe();
          zipWriteStream.end();
          resolve();
        });
      });
    });

    // open up the .zip for reading
    const zipReadStream = createReadStream(zipPath);
    await new Promise((resolve, reject) => {
      zipReadStream.on('error', (err) => {
        reject(err);
      });
      zipReadStream.once('readable', () => {
        console.log('read stream is readable!');
        resolve();
      });
    });
    const length = zipReadStream.readableLength;

    // initiate the publish job
    const url = `${BASE_URL}/environments/${envId}/bots/${botId}/composer/publishoperations?deleteMissingComponents=${deleteMissingComponents}&comment=${encodeURIComponent(
      comment
    )}`;
    const res = await fetch(url, {
      method: 'POST',
      body: zipReadStream,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-CCI-TenantId': tenantId,
        'X-CCI-Routing-TenantId': tenantId,
        'Content-Type': 'application/zip',
        'Content-Length': length.toString(),
        'If-Match': project.eTag,
      },
    });
    const job: PVAPublishJob = await res.json();

    // transform the PVA job to a publish response
    const result = xformJobToResult(job);
    console.log(job);

    // add to publish history
    const botProjectId = project.id;
    ensurePublishProfileHistory(botProjectId, profileName);
    publishHistory[botProjectId][profileName].unshift(result);

    return {
      status: result.status,
      result,
    };
  } catch (e) {
    return {
      status: 500,
      result: {
        message: e.message,
      },
    };
  }
};

export const getStatus = async (
  config: PublishConfig,
  project: IBotProject,
  user: UserIdentity,
  { getAccessToken, loginAndGetIdToken }
): Promise<PublishResponse> => {
  const {
    // these are provided by Composer
    profileName, // the name of the publishing profile "My PVA Prod Slot"

    // these are specific to the PVA publish profile shape
    botId,
    envId,
    tenantId,
  } = config;
  const botProjectId = project.id;

  const operationId = getOperationIdOfLastJob(botProjectId, profileName);
  if (!operationId) {
    // no last job
    return {
      status: 404,
      result: {
        message: `Could not find any publish history for project "${botProjectId}" and profile name "${profileName}"`,
      },
    };
  }

  try {
    // authenticate with PVA
    const idToken = await loginAndGetIdToken(authCredentials);
    const accessToken = await getAccessToken({ ...authCredentials, idToken });

    // check the status for the publish job
    const url = `${BASE_URL}/environments/${envId}/bots/${botId}/composer/publishoperations/${operationId}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-CCI-TenantId': tenantId,
        'X-CCI-Routing-TenantId': tenantId,
        'If-None-Match': project.eTag,
      },
    });
    const job: PVAPublishJob = await res.json();
    console.log(job);

    // transform the PVA job to a publish response
    const result = xformJobToResult(job);

    // update publish history
    const botProjectId = project.id;
    ensurePublishProfileHistory(botProjectId, profileName);
    const oldRecord = publishHistory[botProjectId][profileName].shift();
    result.comment = oldRecord.comment; // persist comment from initial publish
    publishHistory[botProjectId][profileName].unshift(result);

    return {
      status: result.status,
      result,
    };
  } catch (e) {
    return {
      status: 500,
      result: {
        message: e.message,
      },
    };
  }
};

export const history = async (
  config: PublishConfig,
  _project: IBotProject,
  _user: UserIdentity,
  { getAccessToken, loginAndGetIdToken }
): Promise<PublishResult[]> => {
  const {
    // these are specific to the PVA publish profile shape
    botId,
    envId,
    tenantId,
  } = config;

  try {
    // authenticate with PVA
    const idToken = await loginAndGetIdToken(authCredentials);
    const accessToken = await getAccessToken({ ...authCredentials, idToken });

    // get the publish history for the bot
    const url = `${BASE_URL}/environments/${envId}/bots/${botId}/composer/publishoperations`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-CCI-TenantId': tenantId,
        'X-CCI-Routing-TenantId': tenantId,
      },
    });
    const jobs: PVAPublishJob[] = await res.json();

    // TODO (toanzian): only show n-most recent jobs?
    return jobs.map((job) => xformJobToResult(job));
  } catch (e) {
    return [];
  }
};

const xformJobToResult = (job: PVAPublishJob): PublishResult => {
  const result: PublishResult = {
    comment: job.comment,
    eTag: job.importedContentEtag,
    id: job.operationId, // what is this used for in Composer?
    log: job.diagnostics.map((diag) => `---\n${JSON.stringify(diag, null, 2)}\n---\n`).join('\n'),
    message: getUserFriendlyMessage(job.state),
    time: new Date(job.lastUpdateTimeUtc),
    status: getStatusFromJobState(job.state),
  };
  return result;
};

const getStatusFromJobState = (state: PublishState): number => {
  switch (state) {
    case 'Done':
      return 200;

    case 'Failed':
    case 'PreconditionFailed':
      return 500;

    case 'Validating':
    case 'LoadingContent':
    case 'UpdatingSnapshot':
    default:
      return 202;
  }
};

const ensurePublishProfileHistory = (botProjectId: string, profileName: string) => {
  if (!publishHistory[botProjectId]) {
    publishHistory[botProjectId] = {};
  }
  if (!publishHistory[botProjectId][profileName]) {
    publishHistory[botProjectId][profileName] = [];
  }
};

const getOperationIdOfLastJob = (botProjectId: string, profileName: string): string => {
  if (
    publishHistory[botProjectId] &&
    publishHistory[botProjectId][profileName] &&
    !!publishHistory[botProjectId][profileName].length
  ) {
    const mostRecentJob = publishHistory[botProjectId][profileName][0];
    return mostRecentJob.id;
  }
  // couldn't find any jobs for the bot project / profile name combo
  return '';
};

const getUserFriendlyMessage = (state: PublishState): string => {
  switch (state) {
    case 'Done':
      return 'Publish successful.';

    case 'Failed':
      return 'Publish failed. Please check logs.';

    case 'LoadingContent':
      return 'Loading bot content...';

    case 'PreconditionFailed':
      return 'Bot content out of sync. Please check logs.';

    case 'UpdatingSnapshot':
      return 'Updating bot content in PVA...';

    case 'Validating':
      return 'Validating bot assets...';

    default:
      return '';
  }
};
