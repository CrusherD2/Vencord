/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { relaunch } from "@utils/native";
import { chooseFile } from "@utils/web";
import { showToast, useState } from "@webpack/common";

const logger = new Logger("UpdatePlugin");

export function UpdatePluginSection({ pluginName, folderName }: { pluginName: string; folderName: string; }) {
    const [busy, setBusy] = useState(false);

    // Plugins are compiled into Vencord, so updating needs a source checkout to rebuild
    if (IS_WEB || IS_STANDALONE) return null;

    async function update() {
        const file = await chooseFile(".zip,application/zip");
        if (!file) return;
        if (!file.name.toLowerCase().endsWith(".zip"))
            return showToast({ text: `${file.name} is not a .zip file`, variant: "critical" });

        setBusy(true);
        try {
            const res = await VencordNative.userPlugins.update(folderName, {
                fileName: file.name,
                data: new Uint8Array(await file.arrayBuffer())
            });
            if (!res.ok) {
                logger.error(`Failed to update ${pluginName}`, res.error);
                return showToast({ text: res.error?.message ?? `Failed to update ${pluginName}`, variant: "critical" });
            }

            showToast({ text: `Updated ${pluginName}, restarting Discord...`, variant: "success" });
            setTimeout(relaunch, 1500);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section>
            <Heading tag="h3" className={classes(Margins.top16, Margins.bottom8)}>Update plugin</Heading>
            <Paragraph size="sm" className={Margins.bottom8}>
                {busy
                    ? "Rebuilding Vencord, this may take a moment..."
                    : "Replace this plugin with a newer .zip. Your settings are kept, and Discord restarts afterwards."}
            </Paragraph>
            <Button size="small" variant="secondary" disabled={busy} onClick={update}>
                {busy ? "Updating..." : "Update plugin"}
            </Button>
        </section>
    );
}
