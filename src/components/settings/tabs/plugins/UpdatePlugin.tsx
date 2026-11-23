/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { relaunch } from "@utils/native";
import { chooseFile } from "@utils/web";
import { showToast, useState } from "@webpack/common";

import { canUsePluginSources, cl as sourcesCl, findSourceUpdates, SourcePluginUpdateInfo, updatePluginsFromSources, useInstalledVersions, useSourceManifests } from "./PluginSources";

const logger = new Logger("UpdatePlugin");

function sourceStatus({ installedVersion, latest, hasUpdate }: SourcePluginUpdateInfo) {
    const from = `From ${latest.source.name}.`;
    if (installedVersion === null)
        return `${from} Your copy has no version info, so it can't be compared to the latest (${latest.version}). Replacing it overwrites any local edits.`;
    if (hasUpdate) return `${from} Version ${latest.version} is available (you have ${installedVersion}).`;
    return `${from} You have the latest version (${installedVersion}).`;
}

export function UpdatePluginSection({ pluginName, folderName }: { pluginName: string; folderName: string; }) {
    const [busy, setBusy] = useState(false);

    const { pluginSources } = useSettings(["pluginSources"]);
    const { manifests } = useSourceManifests(canUsePluginSources ? pluginSources : []);
    const versions = useInstalledVersions();
    const sourceUpdate = findSourceUpdates(manifests, versions).find(u => u.name === pluginName);

    // Plugins are compiled into Vencord, so updating needs a source checkout to rebuild
    if (IS_WEB || IS_STANDALONE) return null;

    async function run(task: () => Promise<void>) {
        setBusy(true);
        try {
            await task();
        } finally {
            setBusy(false);
        }
    }

    const updateFromZip = () => run(async () => {
        const file = await chooseFile(".zip,application/zip");
        if (!file) return;
        if (!file.name.toLowerCase().endsWith(".zip"))
            return void showToast({ text: `${file.name} is not a .zip file`, variant: "critical" });

        const res = await VencordNative.userPlugins.update(folderName, {
            fileName: file.name,
            data: new Uint8Array(await file.arrayBuffer())
        });
        if (!res.ok) {
            logger.error(`Failed to update ${pluginName}`, res.error);
            return void showToast({ text: res.error?.message ?? `Failed to update ${pluginName}`, variant: "critical" });
        }

        showToast({ text: `Updated ${pluginName}, restarting Discord...`, variant: "success" });
        setTimeout(relaunch, 1500);
    });

    const upToDate = sourceUpdate && sourceUpdate.installedVersion !== null && !sourceUpdate.hasUpdate;

    return (
        <section>
            <Heading tag="h3" className={classes(Margins.top16, Margins.bottom8)}>Update plugin</Heading>
            <Paragraph size="sm" className={Margins.bottom8}>
                {busy
                    ? "Rebuilding Vencord, this may take a moment..."
                    : sourceUpdate
                        ? sourceStatus(sourceUpdate)
                        : "Replace this plugin with a newer .zip. Your settings are kept, and Discord restarts afterwards."}
            </Paragraph>
            <div className={sourcesCl("actions")}>
                {sourceUpdate && (
                    <Button
                        size="small"
                        variant={sourceUpdate.hasUpdate ? "primary" : "secondary"}
                        disabled={busy || upToDate}
                        onClick={() => run(() => updatePluginsFromSources([sourceUpdate]))}
                    >
                        {upToDate
                            ? "Up to date"
                            : sourceUpdate.hasUpdate
                                ? `Update to ${sourceUpdate.latest.version}`
                                : `Replace with ${sourceUpdate.latest.version} from source`}
                    </Button>
                )}
                <Button size="small" variant="secondary" disabled={busy} onClick={updateFromZip}>
                    {sourceUpdate ? "Update from .zip" : "Update plugin"}
                </Button>
            </div>
        </section>
    );
}
