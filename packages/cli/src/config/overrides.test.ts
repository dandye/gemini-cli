/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest/globals" />

import * as osActual from 'node:os';

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof osActual>();
  return {
    ...actualOs,
    homedir: vi.fn(() => '/mock/home/user'),
    platform: vi.fn(() => 'linux'),
  };
});

vi.mock('./settings.js', async (importActual) => {
  const originalModule = await importActual<typeof import('./settings.js')>();
  return {
    ...originalModule,
  };
});

// Mock trustedFolders
import * as trustedFolders from './trustedFolders.js';
vi.mock('./trustedFolders.js', () => ({
  isWorkspaceTrusted: vi.fn(),
  isFolderTrustEnabled: vi.fn(),
  loadTrustedFolders: vi.fn(),
}));

vi.mock('./settingsSchema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settingsSchema.js')>();
  return {
    ...actual,
    getSettingsSchema: vi.fn(actual.getSettingsSchema),
  };
});

import * as path from 'node:path';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mocked,
  type Mock,
} from 'vitest';
import * as fs from 'node:fs';
import stripJsonComments from 'strip-json-comments';

import {
  loadSettings,
  USER_SETTINGS_PATH,
  getSystemSettingsPath,
  findEnvFile,
  findWorkspaceSettingsFile,
  getEnvVarOverrides,
  Settings,
} from './settings.js';
import { GEMINI_DIR } from '@google/gemini-cli-core';

vi.mock('fs', async (importOriginal) => {
  const actualFs = await importOriginal<typeof fs>();
  return {
    ...actualFs,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  };
});

vi.mock('./extension.js');

const mockCoreEvents = vi.hoisted(() => ({
  emitFeedback: vi.fn(),
  emitSettingsChanged: vi.fn(),
}));

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  const os = await import('node:os');
  return {
    ...actual,
    coreEvents: mockCoreEvents,
    homedir: vi.fn(() => os.homedir()),
  };
});

vi.mock('../utils/commentJson.js', () => ({
  updateSettingsFilePreservingFormat: vi.fn(),
}));

vi.mock('strip-json-comments', () => ({
  default: vi.fn((content) => content),
}));

describe('Configuration Overrides', () => {
  let mockFsExistsSync: Mocked<typeof fs.existsSync>;

  const MOCK_WORKSPACE_DIR = '/mock/workspace/project';
  const MOCK_HOME_DIR = '/mock/home/user';

  beforeEach(() => {
    vi.resetAllMocks();
    mockFsExistsSync = vi.mocked(fs.existsSync);
    vi.mocked(osActual.homedir).mockReturnValue(MOCK_HOME_DIR);
    vi.spyOn(trustedFolders, 'isWorkspaceTrusted').mockReturnValue({
      isTrusted: true,
      source: 'file',
    });

    // Default file existence
    (mockFsExistsSync as Mock).mockReturnValue(false);
    (fs.readFileSync as Mock).mockReturnValue('{}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['GEMINI_ENV_FILE'];
    delete process.env['GEMINI_CONFIG'];
    const keysToDelete = Object.keys(process.env).filter(k => k.startsWith('GEMINI_'));
    for (const key of keysToDelete) {
      delete process.env[key];
    }
  });

  describe('findEnvFile', () => {
    it('should respect GEMINI_ENV_FILE environment variable', () => {
      process.env['GEMINI_ENV_FILE'] = '/custom/path/.env';
      const result = findEnvFile(MOCK_WORKSPACE_DIR);
      expect(result).toBe('/custom/path/.env');
    });
  });

  describe('findWorkspaceSettingsFile', () => {
    it('should find settings.json in the current .gemini directory', () => {
      const expectedPath = path.join(MOCK_WORKSPACE_DIR, GEMINI_DIR, 'settings.json');
      (mockFsExistsSync as Mock).mockImplementation((p: string) => p === expectedPath);

      const result = findWorkspaceSettingsFile(MOCK_WORKSPACE_DIR);
      expect(result).toBe(expectedPath);
    });

    it('should find settings.json in parent .gemini directory', () => {
      const parentDir = path.dirname(MOCK_WORKSPACE_DIR);
      const expectedPath = path.join(parentDir, GEMINI_DIR, 'settings.json');
      (mockFsExistsSync as Mock).mockImplementation((p: string) => p === expectedPath);

      const result = findWorkspaceSettingsFile(MOCK_WORKSPACE_DIR);
      expect(result).toBe(expectedPath);
    });

    it('should fallback to workspace root if not found', () => {
       const expectedPath = path.join(MOCK_WORKSPACE_DIR, GEMINI_DIR, 'settings.json');
       (mockFsExistsSync as Mock).mockReturnValue(false);

       const result = findWorkspaceSettingsFile(MOCK_WORKSPACE_DIR);
       expect(result).toBe(expectedPath);
    });

    it('should stop at home directory', () => {
      const homeSettingsPath = path.join(MOCK_HOME_DIR, GEMINI_DIR, 'settings.json');
      // Even if home settings exist, findWorkspaceSettingsFile shouldn't pick them up
      // (user settings handles home) if checking stops at home.
      // Wait, implementation checks if currentDir === home and breaks.

      (mockFsExistsSync as Mock).mockImplementation((p: string) => p === homeSettingsPath);

      const result = findWorkspaceSettingsFile(MOCK_WORKSPACE_DIR);
      // Expect fallback to workspace root
      const defaultPath = path.join(MOCK_WORKSPACE_DIR, GEMINI_DIR, 'settings.json');
      expect(result).toBe(defaultPath);
    });
  });

  describe('GEMINI_CONFIG environment variable', () => {
    it('should load user settings from GEMINI_CONFIG path', () => {
      const customConfigPath = '/custom/config.json';
      process.env['GEMINI_CONFIG'] = customConfigPath;

      const customContent = { ui: { theme: 'custom' } };

      (mockFsExistsSync as Mock).mockImplementation((p: string) => p === customConfigPath);
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === customConfigPath) return JSON.stringify(customContent);
        return '{}';
      });

      const settings = loadSettings(MOCK_WORKSPACE_DIR);
      expect(settings.user.path).toBe(customConfigPath);
      expect(settings.merged.ui?.theme).toBe('custom');
    });
  });

  describe('getEnvVarOverrides', () => {
    it('should parse GEMINI_ keys correctly', () => {
      process.env['GEMINI_UI_THEME'] = 'dark';
      process.env['GEMINI_TOOLS_SANDBOX'] = 'true';
      process.env['GEMINI_MODEL_MAX_SESSION_TURNS'] = '10';

      // Note: Inference is tricky.
      // GEMINI_UI_THEME -> [UI, THEME] -> ui.theme
      // GEMINI_TOOLS_SANDBOX -> [TOOLS, SANDBOX] -> tools.sandbox
      // GEMINI_MODEL_MAX_SESSION_TURNS -> [MODEL, MAX_SESSION_TURNS] -> model.maxSessionTurns

      const overrides = getEnvVarOverrides();

      expect(overrides.ui).toEqual({ theme: 'dark' });
      expect(overrides.tools).toEqual({ sandbox: true });
      expect(overrides.model).toEqual({ maxSessionTurns: 10 });
    });

    it('should handle double underscore for explicit nesting', () => {
       process.env['GEMINI_GENERAL__ENABLE_AUTO_UPDATE'] = 'true';
       process.env['GEMINI_CONTEXT__FILE_FILTERING__ENABLE_FUZZY_SEARCH'] = 'false';

       const overrides = getEnvVarOverrides();

       expect(overrides.general).toEqual({ enableAutoUpdate: true });
       expect(overrides.context).toEqual({
         fileFiltering: { enableFuzzySearch: false }
       });
    });

    it('should handle array/json values', () => {
       process.env['GEMINI_CONTEXT__INCLUDE_DIRECTORIES'] = '["/a", "/b"]';

       const overrides = getEnvVarOverrides();
       expect(overrides.context).toEqual({ includeDirectories: ['/a', '/b'] });
    });
  });

  describe('End-to-end overrides', () => {
    it('should prioritize Env Vars over all files', () => {
       const userContent = { ui: { theme: 'light' } };
       (mockFsExistsSync as Mock).mockImplementation((p: string) => p === USER_SETTINGS_PATH);
       (fs.readFileSync as Mock).mockImplementation((p: string) => {
         if (p === USER_SETTINGS_PATH) return JSON.stringify(userContent);
         return '{}';
       });

       process.env['GEMINI_UI_THEME'] = 'dark';

       const settings = loadSettings(MOCK_WORKSPACE_DIR);

       expect(settings.user.settings.ui?.theme).toBe('light');
       expect(settings.merged.ui?.theme).toBe('dark');
    });
  });
});
