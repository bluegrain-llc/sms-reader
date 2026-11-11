import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'server/test',testMatch:'onboarding.browser.test.ts',fullyParallel:false,workers:1,use:{headless:true},reporter:'list' });
