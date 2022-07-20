import Router from '@koa/router'
import * as childProcess from 'child_process'
import { default as semver } from 'semver'
import * as util from 'util'
import { xdgCache } from 'xdg-basedir'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as gren from 'gren-compiler-library'

import * as log from '#src/log'
import * as db from '#src/db'
import * as views from '#src/views'


export const router = new Router();

const execFile = util.promisify(childProcess.execFile);


router.get('/package/jobs', async (ctx, next) => {
    try {
        const rows = await getAllJobs();

        views.render(ctx, {
            html: () => views.packageJobs({ jobs: rows }),
            json: () => JSON.stringify(rows, null, 4),
            text: () => `${rows.length} jobs`
        });
    } catch (err) {
        log.error('Failed to get all import jobs', err);
        ctx.throw(500);
    }
});


router.post('/package/:name/sync', async (ctx, next) => {
    const packageName = ctx.params.name;
    const githubUrl = githubUrlForName(packageName);

    try {
        await registerJob(packageName, githubUrl, '*', stepFindMissingVersions);

        log.info(`Begin import of ${packageName}`);

        ctx.status = 303;
        ctx.redirect('/package/jobs');
    } catch (error) {
        // 19: SQLITE_CONSTRAINT, means row already exists
        if (error.errno === 19) {
            ctx.throw(409);
        } else {
            log.error('Failed to save initial package import job.', error);
            ctx.throw(500);
        }
    }
});

function githubUrlForName(name) {
    return `https://github.com/${name}.git`;
}

// DB queries

function getAllJobs() {
    return db.query(`
SELECT * FROM package_import_jobs
`, {});
}

function getInProgressJob() {
    return db.queryOne(`
SELECT *
FROM package_import_jobs
WHERE in_progress = TRUE
AND process_after < datetime()
ORDER BY process_after
LIMIT 1
`, {});
}

const stepFindMissingVersions = 'FIND_MISSING_VERSIONS';
const stepCloneRepo = 'CLONE_REPO';
const stepBuildDocs = 'BUILD_DOCS';
const stepCleanup = 'CLEANUP';

function registerJob(name, url, version, step) {
    return db.run(`
INSERT INTO package_import_jobs (
    name,
    url,
    version,
    step,
    in_progress,
    retry,
    process_after,
    message
) VALUES (
    $name,
    $url,
    $version,
    $step,
    TRUE,
    0,
    datetime(),
    'Waiting to execute'
)
`, {
    $name: name,
    $url: url,
    $version: version,
    $step: step
});
}

const retryTimeIncreaseInSeconds = [
    5,
    15,
    60,
    300,
    600
];

function scheduleJobForRetry(id, numberOfTimesRetried, reason) {
    const nextTimeIncrease = retryTimeIncreaseInSeconds[numberOfTimesRetried];

    if (!nextTimeIncrease) {
        return advanceJob(id, stepCleanup);
    }
    
    return db.run(`
UPDATE package_import_jobs
SET 
    message = $reason,
    retry = retry + 1,
    process_after = datetime('now', $nextTimeIncrease)
WHERE
    id = $id
`, {
    $id: id,
    $reason: `${reason}, will retry`,
    $nextTimeIncrease: `${nextTimeIncrease} seconds`
});
}

function advanceJob(id, nextStep) {
    return db.run(`
UPDATE package_import_jobs
SET 
    step = $nextStep,
    retry = 0,
    process_after = datetime(),
    message = 'Waiting to execute'
WHERE
    id = $id
`, {
    $id: id,
    $nextStep: nextStep
});
}

function stopJob(id, reason) {
    return db.run(`
UPDATE package_import_jobs
SET 
    in_progress = FALSE,
    message = $reason,
    process_after = datetime()
WHERE
    id = $id
`, {
    $id: id,
    $reason: reason
});
}

async function cleanup() {
    const changes = await db.run(`
DELETE FROM package_import_jobs 
WHERE in_progress = FALSE
AND process_after < datetime('now', '-1 minute')
`, {});

    if (changes > 0) {
        log.info(`Deleted ${changes} stale package jobs.`);
    }
}

function registerDocs(name, url, version, metadata, readme, docs) {
    return db.run(`
INSERT INTO packages (
    name,
    version,
    url,
    imported,
    metadata,
    readme,
    docs
) VALUES (
    $name,
    $version,
    $url,
    datetime(),
    $metadata,
    $readme,
    $docs
)
`, {
    $name: name,
    $url: url,
    $version: version,
    $metadata: metadata,
    $readme: readme,
    $docs: docs
});
}

function existingVersions(name) {
    return db.query(`
SELECT version
FROM packages
WHERE name = $name
`, {
    $name: name,
});
}

// Scheduled job

async function scheduledJob() {
    try {
        await whenScheduled();
    } catch (err) {
        log.error(`Error when running scheduled job.`, err);
    }
    
    setTimeout(scheduledJob, 1000);
}

async function whenScheduled() {
    const job = await getInProgressJob();
    
    if (job) {
        log.info('Executing job', job);
        await performJob(job);
    }
}

async function performJob(job) {
    switch (job.step) {
        case stepFindMissingVersions:
            await findMissingVersions(job);
            break;
        case stepCloneRepo:
            await cloneRepo(job);
            break;
        case stepBuildDocs:
            await buildDocs(job);
            break;
        case stepCleanup:
            await removeJobWorkingDir(job);
            break;
        default:
            log.error(`Don't know what to do with job at step ${job.step}`, job); 
            await stopJob(job.id, 'Don\'t know what to do...');
            break;
    }
}

async function findMissingVersions(job) {
    try {
        const { stdout } = await execFile('git', [ 'ls-remote', '--tags', job.url ], {
            timeout: 3000
        });

        const alreadyImportedVersionRows = await existingVersions(job.name);
        
        const alreadyImportedVersions =
            alreadyImportedVersionRows.map((row) => row.version);

        const entries = stdout
            .trim()
            .split('\n')
            .map((entry) => entry.split('\t'))
            .map(([hash, tag]) => tag.replace('refs/tags/', ''))
            .filter((tag) => semver.valid(tag))
            .filter((tag) => !alreadyImportedVersions.includes(tag));

        log.info(`Registering jobs for importing new versions of ${job.name}`, entries);

        for (let tag of entries) {
            try {
                await registerJob(job.name, job.url, tag, stepCloneRepo);
            } catch (error) {
                // 19: SQLITE_CONSTRAINT, means row already exists
                if (error.errno === 19) {
                    // ignore
                } else {
                    log.error(
                        'Unknown error when trying to register import job for ${job.name} version ${tag}.', 
                        error
                    );
                }
            }
        }

        await stopJob(job.id, 'Completed successfully');
    } catch (error) {
        if (error.code === 128) {
            await stopJob(job.id, `Repository doesn\'t exist: ${job.url}`);
        } else {
            log.error('Unknown error when finding tags for remote git repo', error);
            await scheduleJobForRetry(
                job.id,
                job.retry,
                'Unknown error when finding tags for git repo.'
            );
        }
    }
}

async function cloneRepo(job) {
    try {
        const localRepoPath = getLocalRepoPath(job);

        await fs.rm(localRepoPath, { force: true, recursive: true });
        await fs.mkdir(localRepoPath, { recursive: true });
        
        await execFile('git', [ 'clone', '--branch', job.version, '--depth', '1', job.url, localRepoPath ], {
            timeout: 10_000
        });

        log.info(`Successfully cloned repo for package ${job.name} at version ${job.version}`, job);

        await advanceJob(job.id, stepBuildDocs);
    } catch (error) {
        log.error('Unknown error when cloning remote git repo', error);
        await scheduleJobForRetry(
            job.id,
            job.retry,
            'Unknown error when cloning git repo.'
        );
    }
}

function getLocalRepoPath(job) {
    return path.join(xdgCache, 'gren_packages', job.id.toString());
}

async function buildDocs(job) {
    try {
        const compilerPath = gren.compilerPath;
        const compilerArgs = [
            'make',
            '--docs=./docs.json',
            '--report=json'
        ];

        const localRepoPath = getLocalRepoPath(job);
        
        await execFile(compilerPath, compilerArgs, {
            cwd: localRepoPath,
            env: { 
                ...process.env, 
                'GREN_HOME': path.join(localRepoPath, '.gren', 'home')
            },
            timeout: 30_000
        });

        const metadata = await fs.readFile(path.join(localRepoPath, 'gren.json'), { encoding: 'utf-8' });
        const readme = await fs.readFile(path.join(localRepoPath, 'README.md'), { encoding: 'utf-8' });
        const docs = await fs.readFile(path.join(localRepoPath, 'docs.json'), { encoding: 'utf-8' });

        await registerDocs(job.name, job.url, job.version, metadata, readme, docs);

        log.info(`Successfully compiled package ${job.name} at version ${job.version}`, job);

        await advanceJob(job.id, stepCleanup);
    } catch (error) {
        // 19: SQLITE_CONSTRAINT, means row already exists
        if (error.errno === 19) {
            log.info(`Package ${job.name} at version ${job.version} already exist in our system`, job);
            await advanceJob(job.id, stepCleanup);
            return;
        }
        
        let compilerError;
        try {
            compilerError = JSON.parse(error.stderr);
        } catch (parseError) {
            compilerError = error;
        }

        if (compilerError.title === 'NO gren.json FILE') {
            log.error('Package doesn\'t contain gren.json file', compilerError);
            await scheduleJobForRetry(
                job.id,
                job.retry,
                'Package doesn\'t contain gren.json file'
            );
        } else if (compilerError.title === 'GREN VERSION MISMATCH') {
            log.error('Package does not support current Gren compiler', compilerError);
            await scheduleJobForRetry(
                job.id,
                job.retry,
                'Package doesn\'t support current Gren compiler.'
            );
        } else {
            log.error('Unknown error when compiling project', compilerError);
            await scheduleJobForRetry(
                job.id,
                job.retry,
                'Unknown error when compiling project.'
            );
        }
    }
}

async function removeJobWorkingDir(job) {
    try {
        const localRepoPath = getLocalRepoPath(job);

        await fs.rm(localRepoPath, { recursive: true });
        
        log.info(`Successfully cleaned workspace for package ${job.name} at version ${job.version}`, job);

        await stopJob(job.id, 'Import complete');
    } catch (error) {
        log.error('Unknown error when trying to cleanup after import.', error);
        await scheduleJobForRetry(
            job.id,
            job.retry,
            'Unknown error when trying to cleanup after import.'
        );
    }
}

setTimeout(scheduledJob, 5000);

setInterval(cleanup, 5000);
