/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    addressEvent,
    HandlerContext,
    Maker,
    OnCommand,
    Project,
    ProjectPersister,
    RemoteRepoRef,
    RepoCreationParameters,
    RepoRef,
    SeedDrivenGeneratorParameters,
    Success,
} from "@atomist/automation-client";
import { HandleCommand } from "@atomist/automation-client/lib/HandleCommand";
import { RedirectResult } from "@atomist/automation-client/lib/HandlerResult";
import { commandHandlerFrom } from "@atomist/automation-client/lib/onCommand";
import { CommandDetails } from "@atomist/automation-client/lib/operations/CommandDetails";
import { ProjectAction } from "@atomist/automation-client/lib/operations/common/projectAction";
import {
    isRemoteRepoRef,
    ProviderType,
} from "@atomist/automation-client/lib/operations/common/RepoId";
import { RepoLoader } from "@atomist/automation-client/lib/operations/common/repoLoader";
import { AnyProjectEditor } from "@atomist/automation-client/lib/operations/edit/projectEditor";
import { generate } from "@atomist/automation-client/lib/operations/generate/generatorUtils";
import { isProject } from "@atomist/automation-client/lib/project/Project";
import { toFactory } from "@atomist/automation-client/lib/util/constructionUtils";
import {
    bold,
    codeBlock,
    url,
} from "@atomist/slack-messages";
import { SoftwareDeliveryMachineOptions } from "../../../api/machine/SoftwareDeliveryMachineOptions";
import { CommandRegistration } from "../../../api/registration/CommandRegistration";
import {
    GeneratorRegistration,
    StartingPoint,
} from "../../../api/registration/GeneratorRegistration";
import { constructProvenance } from "../../goal/storeGoals";
import {
    CommandListenerExecutionInterruptError,
    resolveCredentialsPromise,
    toCommandListenerInvocation,
} from "../../machine/handlerRegistrations";
import { projectLoaderRepoLoader } from "../../machine/projectLoaderRepoLoader";
import {
    MachineOrMachineOptions,
    toMachineOptions,
} from "../../machine/toMachineOptions";
import {
    slackErrorMessage,
    slackInfoMessage,
    slackSuccessMessage,
} from "../../misc/slack/messages";
import { CachingProjectLoader } from "../../project/CachingProjectLoader";

/**
 * Create a command handler for project generation
 * @param sdm this machine or its options
 * @param {EditorFactory<P extends SeedDrivenGeneratorParameters>} editorFactory to create editorCommand to perform transformation
 * @param {Maker<P extends SeedDrivenGeneratorParameters>} paramsMaker
 * @param {string} name
 * @param {Partial<GeneratorCommandDetails<P extends SeedDrivenGeneratorParameters>>} details
 * @return {HandleCommand}
 */
export function generatorCommand<P>(sdm: MachineOrMachineOptions,
                                    editorFactory: EditorFactory<P>,
                                    name: string,
                                    paramsMaker: Maker<P>,
                                    fallbackTarget: Maker<RepoCreationParameters>,
                                    startingPoint: StartingPoint<P>,
                                    details: Partial<GeneratorCommandDetails<any>> = {},
                                    cr: GeneratorRegistration<P>): HandleCommand {
    const detailsToUse: GeneratorCommandDetails<any> = {
        ...defaultDetails(toMachineOptions(sdm), name),
        ...details,
    };
    return commandHandlerFrom(handleGenerate(editorFactory, detailsToUse, startingPoint, cr, toMachineOptions(sdm)),
        toGeneratorParametersMaker<P>(
            paramsMaker,
            toFactory(fallbackTarget)()),
        name,
        detailsToUse.description, detailsToUse.intent, detailsToUse.tags);
}

export type EditorFactory<P> = (params: P, ctx: HandlerContext) => AnyProjectEditor<P>;

interface GeneratorCommandDetails<P extends SeedDrivenGeneratorParameters> extends CommandDetails {

    redirecter: (r: RepoRef) => string;
    projectPersister?: ProjectPersister;
    afterAction?: ProjectAction<P>;
}

/**
 * Return a parameters maker that is targeting aware
 * @param {Maker<PARAMS>} paramsMaker
 * @return {Maker<EditorOrReviewerParameters & PARAMS>}
 */
export function toGeneratorParametersMaker<PARAMS>(paramsMaker: Maker<PARAMS>,
                                                   target: RepoCreationParameters): Maker<SeedDrivenGeneratorParameters & PARAMS> {
    const sampleParams = toFactory(paramsMaker)();
    return isSeedDrivenGeneratorParameters(sampleParams) ?
        paramsMaker as Maker<SeedDrivenGeneratorParameters & PARAMS> as any :
        () => {
            // This way we won't bother with source, but rely on startingPoint
            const rawParms: PARAMS = toFactory(paramsMaker)();
            const allParms = rawParms as SeedDrivenGeneratorParameters & PARAMS;
            allParms.target = target;
            return allParms;
        };
}

export function isSeedDrivenGeneratorParameters(p: any): p is SeedDrivenGeneratorParameters {
    const maybe = p as SeedDrivenGeneratorParameters;
    return !!maybe && !!maybe.target;
}

function handleGenerate<P extends SeedDrivenGeneratorParameters>(editorFactory: EditorFactory<P>,
                                                                 details: GeneratorCommandDetails<P>,
                                                                 startingPoint: StartingPoint<P>,
                                                                 cr: GeneratorRegistration<P>,
                                                                 sdmo: SoftwareDeliveryMachineOptions): OnCommand<P> {

    return (ctx: HandlerContext, parameters: P) => {
        return handle(ctx, editorFactory, parameters, details, startingPoint, cr, sdmo);
    };
}

async function handle<P extends SeedDrivenGeneratorParameters>(ctx: HandlerContext,
                                                               editorFactory: EditorFactory<P>,
                                                               params: P,
                                                               details: GeneratorCommandDetails<P>,
                                                               startingPoint: StartingPoint<P>,
                                                               cr: GeneratorRegistration<P>,
                                                               sdmo: SoftwareDeliveryMachineOptions): Promise<RedirectResult> {
    try {

        const pi = {
            ...toCommandListenerInvocation(cr, ctx, params, sdmo),
            ...params,
        } as any;
        pi.credentials = await resolveCredentialsPromise(pi.credentials);

        const r = await generate(
            computeStartingPoint(params, ctx, details.repoLoader(params), details, startingPoint, cr, sdmo),
            ctx,
            pi.credentials,
            editorFactory(params, ctx),
            details.projectPersister,
            params.target.repoRef,
            params,
            undefined, // set to undefined as we run the afterActions below explicitly
        );

        if (!!cr.afterAction && r.success === true) {
            const afterActions = Array.isArray(cr.afterAction) ? cr.afterAction : [cr.afterAction];

            for (const afterAction of afterActions) {
                await afterAction(r.target, pi);
            }
        }

        // TODO cd support other providers which needs to start upstream from this
        if (params.target.repoRef.providerType === ProviderType.github_com && r.success === true) {
            const repoProvenance = {
                repo: {
                    name: params.target.repoRef.repo,
                    owner: params.target.repoRef.owner,
                    providerId: "zjlmxjzwhurspem",
                },
                provenance: constructProvenance(ctx),
            };
            await ctx.messageClient.send(repoProvenance, addressEvent("SdmRepoProvenance"));
        }

        await ctx.messageClient.respond(
            slackSuccessMessage(
                `Create Project`,
                `Successfully created new project ${bold(`${params.target.repoRef.owner}/${
                    params.target.repoRef.repo}`)} at ${url(params.target.repoRef.url)}`));
        return {
            code: 0,
            // Redirect to local project page
            redirect: details.redirecter(params.target.repoRef),
            // local SDM uses this to print instructions
            generatedRepositoryUrl: params.target.repoRef.url,
        } as any;
    } catch (err) {
        if (err instanceof CommandListenerExecutionInterruptError) {
            // We're continuing
            return Success as any;
        }

        await ctx.messageClient.respond(
            slackErrorMessage(
                `Create Project`,
                `Project creation for ${bold(`${params.target.repoRef.owner}/${params.target.repoRef.repo}`)} failed:
${codeBlock(err.message)}`,
                ctx));
    }
    return undefined;
}

/**
 * Retrieve a seed. Set the seed location on the parameters if possible and necessary.
 */
export async function computeStartingPoint<P extends SeedDrivenGeneratorParameters>(params: P,
                                                                                    ctx: HandlerContext,
                                                                                    repoLoader: RepoLoader,
                                                                                    details: GeneratorCommandDetails<any>,
                                                                                    startingPoint: StartingPoint<P>,
                                                                                    cr: CommandRegistration<P>,
                                                                                    sdmo: SoftwareDeliveryMachineOptions): Promise<Project> {
    if (!startingPoint) {
        if (!params.source || !params.source.repoRef) {
            throw new Error("If startingPoint is not provided in GeneratorRegistration, parameters.source must specify seed project location: " +
                `Offending registration had intent ${details.intent}`);
        }
        await infoMessage(`Cloning seed project from parameters ${url(params.source.repoRef.url)}`, ctx);
        return repoLoader(params.source.repoRef);
    }
    if (isProject(startingPoint)) {
        await infoMessage(`Using starting point project specified in registration`, ctx);
        return startingPoint;
    } else if (isRemoteRepoRef(startingPoint as RepoRef)) {
        const source = startingPoint as RemoteRepoRef;
        await infoMessage(`Cloning seed project from starting point ${bold(`${source.owner}/${source.repo}`)} at ${url(source.url)}`, ctx);
        const repoRef = startingPoint as RemoteRepoRef;
        params.source = { repoRef };
        return repoLoader(repoRef);
    } else {
        // Combine this for backward compatibility
        const pi = {
            ...toCommandListenerInvocation(cr, ctx, params, sdmo),
            ...params,
        };
        pi.credentials = await resolveCredentialsPromise(pi.credentials);
        // It's a function that takes the parameters and returns either a project or a RemoteRepoRef
        const rr: RemoteRepoRef | Project | Promise<Project> = (startingPoint as any)(pi);
        if (isProjectPromise(rr)) {
            const p = await rr;
            await infoMessage(`Using dynamically chosen starting point project ${bold(`${p.id.owner}:${p.id.repo}`)}`, ctx);
            return p;
        }
        if (isProject(rr)) {
            await infoMessage(`Using dynamically chosen starting point project ${bold(`${rr.id.owner}:${rr.id.repo}`)}`, ctx);
            // params.source will remain undefined in this case
            return rr;
        } else {
            await infoMessage(`Cloning dynamically chosen starting point from ${url(rr.url)}`, ctx);
            params.source = { repoRef: rr };
            return repoLoader(rr);
        }
    }
}

function isProjectPromise(a: any): a is Promise<Project> {
    return !!a.then;
}

function defaultDetails<P extends SeedDrivenGeneratorParameters>(opts: SoftwareDeliveryMachineOptions, name: string): GeneratorCommandDetails<P> {
    return {
        description: name,
        repoFinder: opts.repoFinder,
        repoLoader: (p: P) => projectLoaderRepoLoader(opts.projectLoader || new CachingProjectLoader(),
            p.target.credentials, true),
        projectPersister: opts.projectPersister,
        redirecter: () => undefined,
    };
}

async function infoMessage(text: string, ctx: HandlerContext): Promise<void> {
    return ctx.messageClient.respond(slackInfoMessage("Create Project", text));
}
