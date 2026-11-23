/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./AddPlugins.css";

import { Card } from "@components/Card";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { relaunch } from "@utils/native";
import { chooseFiles } from "@utils/web";
import { Clickable, showToast, useState } from "@webpack/common";
import type { DragEvent } from "react";

const cl = classNameFactory("vc-add-plugins-");
const logger = new Logger("AddPlugins");

export function AddPluginsButton() {
    const [dragging, setDragging] = useState(false);
    const [busy, setBusy] = useState(false);

    // Plugins are compiled into Vencord, so installing needs a source checkout to rebuild
    if (IS_WEB || IS_STANDALONE) return null;

    async function install(files: File[]) {
        if (!files.length || busy) return;

        const notZip = files.find(f => !f.name.toLowerCase().endsWith(".zip"));
        if (notZip) return showToast({ text: `${notZip.name} is not a .zip file`, variant: "critical" });

        setBusy(true);
        try {
            const res = await VencordNative.userPlugins.install(await Promise.all(files.map(async f => ({
                fileName: f.name,
                data: new Uint8Array(await f.arrayBuffer())
            }))));
            if (!res.ok) {
                logger.error("Failed to install plugins", res.error);
                return showToast({ text: res.error?.message ?? "Failed to install plugins", variant: "critical" });
            }

            showToast({ text: `Installed ${res.value.join(", ")}, restarting Discord...`, variant: "success" });
            setTimeout(relaunch, 1500);
        } finally {
            setBusy(false);
        }
    }

    function onDragOver(e: DragEvent) {
        e.preventDefault();
        setDragging(true);
    }

    function onDrop(e: DragEvent) {
        e.preventDefault();
        setDragging(false);
        install(Array.from(e.dataTransfer.files));
    }

    return (
        <Clickable onClick={() => chooseFiles(".zip,application/zip").then(install)}>
            <Card
                className={classes(cl("dropzone"), dragging && cl("dragging"), busy && cl("busy"))}
                defaultPadding
                onDragOver={onDragOver}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
            >
                <Paragraph size="md" weight="semibold">
                    {busy ? "Installing plugins..." : "Add plugins"}
                </Paragraph>
                <Paragraph size="xs">
                    {busy ? "Rebuilding Vencord, this may take a moment" : "Drop plugin .zip files here or click to select them"}
                </Paragraph>
            </Card>
        </Clickable>
    );
}
