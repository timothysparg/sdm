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

import { Fingerprint } from "@atomist/automation-client/lib/project/fingerprint/Fingerprint";
import * as assert from "power-assert";
import { TypedFingerprint } from "../../../../lib/api-helper/code/fingerprint/TypedFingerprint";
import { computeShaOf } from "../../../../lib/api-helper/misc/sha";

interface Person {
    name: string;
    age: number;
}

describe("TypedFingerprint", () => {

    it("should serialize sha", () => {
        const fp = new TypedFingerprint<Person>("name", "ABR", "0.1.0", {
            name: "tony",
            age: 65,
        });
        const ser = JSON.stringify(fp);
        const parsed = JSON.parse(ser) as Fingerprint;
        assert.strictEqual(parsed.sha, computeShaOf(fp.data));
    });

    it("should convert valid data", () => {
        const fp = new TypedFingerprint<Person>("name", "ABR", "0.1.0", {
            name: "tony",
            age: 65,
        });
        assert.equal(fp.object.name, "tony");
        assert.equal(fp.object.age, 65);
        assert.equal(JSON.parse(fp.data).name, "tony");
        assert.equal(JSON.parse(fp.data).age, 65);
    });

    it("should compute sha", () => {
        const fp = new TypedFingerprint<Person>("name", "ABR", "0.1.0", {
            name: "tony",
            age: 65,
        });
        assert(!!fp.sha);
        assert(isValidSHA1(fp.sha));
    });

});

function isValidSHA1(s: string): boolean {
    return s.match(/[a-fA-F0-9]{40}/) !== undefined;
}
