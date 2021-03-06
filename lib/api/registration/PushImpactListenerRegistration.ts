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

import { PushImpactListenerInvocation } from "../listener/PushImpactListener";
import { PushRegistration } from "./PushRegistration";

/**
 * A code action response that affects delivery:
 * failing the current goal or requiring approval,
 * causing dependent goals to fail or wait.
 */
export enum PushImpactResponse {

    /**
     * Everything's good. Keep going.
     */
    proceed = "proceed",

    /**
     * Fail execution of the present goalset. Any dependent goals will stop.
     * Will not stop execution of non-dependent goals.
     */
    failGoals = "fail",

    /**
     * Require approval to proceed to dependent goals in the present goalset.
     */
    requireApprovalToProceed = "requireApproval",
}

type DefaultPushImpactListenerResult = void | PushImpactResponse;

/**
 * Reaction on a push, with the code available.
 * Can optionally return a response that
 * determines whether to ask for approval or terminate current delivery flow.
 */
export type PushImpactListener<R = DefaultPushImpactListenerResult> = (i: PushImpactListenerInvocation) => Promise<R>;

/**
 * Used to register actions on a push that can potentially
 * influence downstream goals. Will be invoked if a PushReactionGoal has
 * been set for the given push.
 * Use ReviewerRegistration if you want to return a structured review.
 */
export type PushImpactListenerRegistration<R = DefaultPushImpactListenerResult> = PushRegistration<PushImpactListener<R>>;

/**
 * Something we can register as a push reaction
 */
export type PushImpactListenerRegisterable<R = DefaultPushImpactListenerResult> = PushImpactListenerRegistration<R> | PushImpactListener<R>;

function isPushReactionRegistration(a: PushImpactListenerRegisterable<any>): a is PushImpactListenerRegistration {
    const maybe = a as PushRegistration<any>;
    return !!maybe.name && !!maybe.action;
}

/**
 * Convert an action function to a PushImpactListener if necessary
 * @param {PushImpactListenerRegisterable<any>} prr
 * @return {PushImpactListenerRegistration}
 */
export function toPushReactionRegistration(prr: PushImpactListenerRegisterable): PushImpactListenerRegistration {
    return isPushReactionRegistration(prr) ? prr : {
        name: "Raw push reaction",
        action: prr,
    };
}
