/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface SourcePluginAuthor {
    name: string;
    github?: string;
}

export interface SourcePlugin {
    name: string;
    folder: string;
    description: string;
    category: string;
    version: string;
    authors: SourcePluginAuthor[];
    target: string | null;
    requirements: string[];
}

export interface PluginSourceManifest {
    url: string;
    name: string;
    plugins: SourcePlugin[];
}

export interface SourcePluginSelection {
    url: string;
    folder: string;
}

const GITHUB_REPO_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;

export const PLUGIN_FOLDER_RE = /^[\w-][\w.-]*$/;

/**
 * Parses a GitHub repository link like `https://github.com/owner/repo` (extra path segments are ignored)
 * @returns The owner, repo and normalised url, or null if the link is not a GitHub repository
 */
export function parsePluginSource(url: string) {
    const match = url.trim().match(GITHUB_REPO_RE);
    if (!match) return null;

    const [, owner, repo] = match;
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}
