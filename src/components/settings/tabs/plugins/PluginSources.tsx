/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./PluginSources.css";

import { Settings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Heading } from "@components/Heading";
import { DeleteIcon, OpenExternalIcon } from "@components/Icons";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { AddonCard } from "@components/settings/AddonCard";
import { parsePluginSource, PluginSourceManifest, SourcePlugin, SourcePluginSelection } from "@shared/pluginSources";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { relaunch } from "@utils/native";
import { useAwaiter } from "@utils/react";
import { showToast, TextInput, useState } from "@webpack/common";

const cl = classNameFactory("vc-plugin-sources-");
const logger = new Logger("PluginSources");

export interface SourcePluginEntry extends SourcePlugin {
    source: PluginSourceManifest;
}

export interface SourceResults {
    manifests: PluginSourceManifest[];
    errors: Record<string, string>;
    pending: boolean;
}

export const sourcePluginKey = (p: SourcePluginEntry) => `${p.source.url}#${p.folder}`;

// Plugins are compiled into Vencord, so installing needs a source checkout to rebuild
export const canUsePluginSources = !IS_WEB && !IS_STANDALONE;

export function useSourceManifests(sources: string[]): SourceResults {
    const [results, , pending] = useAwaiter(async () => {
        const manifests: PluginSourceManifest[] = [];
        const errors: Record<string, string> = {};
        await Promise.all(sources.map(async url => {
            const res = await VencordNative.userPlugins.getSource(url);
            if (res.ok) manifests.push(res.value);
            else errors[url] = res.error?.message ?? "Failed to load source";
        }));
        manifests.sort((a, b) => sources.indexOf(a.url) - sources.indexOf(b.url));
        return { manifests, errors };
    }, { fallbackValue: { manifests: [], errors: {} }, deps: [sources.join("\n")] });

    return { ...results, pending };
}

export function PluginSourcesSection({ sources, results }: { sources: string[]; results: SourceResults; }) {
    const [input, setInput] = useState("");
    const [adding, setAdding] = useState(false);

    async function addSource() {
        const source = parsePluginSource(input);
        if (!source)
            return showToast({ text: "Enter a GitHub repository link, like https://github.com/owner/repo", variant: "critical" });
        if (sources.includes(source.url))
            return showToast({ text: "That source is already added", variant: "critical" });

        setAdding(true);
        try {
            const res = await VencordNative.userPlugins.getSource(source.url);
            if (!res.ok) return showToast({ text: res.error?.message ?? "Failed to load source", variant: "critical" });

            Settings.pluginSources = [...sources, source.url];
            setInput("");
            showToast({ text: `Added ${res.value.name} (${res.value.plugins.length} plugins)`, variant: "success" });
        } finally {
            setAdding(false);
        }
    }

    return (
        <Card className={cl("card")} defaultPadding>
            <Paragraph size="md" weight="semibold">Plugin sources</Paragraph>
            <Paragraph size="xs">
                Add a GitHub repo with a plugins.json and its plugins appear in the list below, ready to install.
                Plugins run with full access to Discord and your computer, so only add sources you trust.
            </Paragraph>

            <div className={cl("add")}>
                <TextInput
                    placeholder="https://github.com/owner/repo"
                    value={input}
                    onChange={setInput}
                    onKeyDown={e => { if (e.key === "Enter") addSource(); }}
                />
                <Button size="small" disabled={adding || !input.trim()} onClick={addSource}>
                    {adding ? "Adding..." : "Add"}
                </Button>
            </div>

            {sources.map(url => {
                const manifest = results.manifests.find(m => m.url === url);
                const error = results.errors[url];
                return (
                    <div key={url} className={cl("row")}>
                        <div className={cl("row-info")}>
                            <Paragraph size="sm" weight="semibold">{manifest?.name ?? url}</Paragraph>
                            <Paragraph size="xs" className={error ? cl("error") : undefined}>
                                <Link href={url}>{url.replace("https://github.com/", "")}</Link>
                                {" · "}
                                {error ?? (manifest ? `${manifest.plugins.length} plugins` : "Loading...")}
                            </Paragraph>
                        </div>
                        <Button
                            size="iconOnly"
                            variant="dangerSecondary"
                            aria-label={`Remove ${url}`}
                            onClick={() => Settings.pluginSources = sources.filter(s => s !== url)}
                        >
                            <DeleteIcon width={16} height={16} />
                        </Button>
                    </div>
                );
            })}
        </Card>
    );
}

export function SourcePluginCard({ plugin, selected, onToggle }: { plugin: SourcePluginEntry; selected: boolean; onToggle(): void; }) {
    const authors = plugin.authors.map(a => a.name).join(", ");
    const folderUrl = `${plugin.source.url}/tree/HEAD/plugins/${encodeURIComponent(plugin.folder)}`;

    return (
        <AddonCard
            name={plugin.name}
            description={plugin.description}
            author={`${authors ? `by ${authors} · ` : ""}${plugin.source.name}`}
            enabled={selected}
            setEnabled={onToggle}
            infoButton={
                <button
                    className="vc-plugins-info-button"
                    aria-label={`View ${plugin.name} on GitHub`}
                    onClick={() => VencordNative.native.openExternal(folderUrl)}
                >
                    <OpenExternalIcon className="vc-plugins-info-icon" />
                </button>
            }
        />
    );
}

export function InstallSourcePluginsCard({ selected, onCancel }: { selected: SourcePluginEntry[]; onCancel(): void; }) {
    const [busy, setBusy] = useState(false);

    async function install() {
        setBusy(true);
        try {
            const selections: SourcePluginSelection[] = selected.map(p => ({ url: p.source.url, folder: p.folder }));
            const res = await VencordNative.userPlugins.installFromSources(selections);
            if (!res.ok) {
                logger.error("Failed to install plugins from sources", res.error);
                return showToast({ text: res.error?.message ?? "Failed to install plugins", variant: "critical" });
            }

            // Turn them on so they are active right after the restart
            for (const { name } of selected) {
                const pluginSettings = Settings.plugins[name];
                if (pluginSettings) pluginSettings.enabled = true;
                else Settings.plugins[name] = { enabled: true };
            }

            showToast({ text: `Installed ${selected.map(p => p.name).join(", ")}, restarting Discord...`, variant: "success" });
            setTimeout(relaunch, 1500);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card variant="warning" className={Margins.top16} defaultPadding>
            <Heading tag="h4">
                {busy ? "Installing plugins..." : `Install ${selected.length} plugin${selected.length === 1 ? "" : "s"}?`}
            </Heading>
            <Paragraph className={Margins.bottom8}>
                {busy
                    ? "Downloading and rebuilding Vencord, this may take a moment"
                    : `${selected.map(p => p.name).join(", ")} will be downloaded, built into Vencord and turned on. Discord restarts afterwards.`}
            </Paragraph>
            <div className={cl("actions")}>
                <Button size="small" disabled={busy} onClick={install}>Install & restart</Button>
                <Button size="small" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
            </div>
        </Card>
    );
}
