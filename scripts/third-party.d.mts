import type { Plugin } from 'vite'

export interface ThirdParty {
  name: string
  version: string
  license: string
  licenseText: string | null
  noticeText: string | null
  source: string | null
  where: string[]
  modified?: string
}

export const ALLOWED: string[]
export function bundledLicenses(where: string, output: (packages: ThirdParty[]) => void): Plugin
export function packageLicense(dir: string, where: string): ThirdParty
export function packageDir(name: string, from: string): string
export function cssImports(file: string, where: string): ThirdParty[]
export function markedFiles(dir: string, marker: string, base: string): string[]
export function renderNotices(
  name: string,
  packages: ThirdParty[],
  copied: {
    title: string
    license: string
    licenseText: string
    source: string
    files: string[]
  }[],
): string
