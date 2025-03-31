import { ESLint } from "eslint";
import powerbiPlugin from 'eslint-plugin-powerbi-visuals';
import ConsoleWriter from "./ConsoleWriter.js";
import { LintOptions } from "./CommandManager.js";
import { getRootPath } from "./utils.js";
import path from "path";
import fs from 'fs-extra';

export class LintValidator {

    private readonly visualPath: string;
    private rootPath: string;
    private readonly isVerboseMode: boolean;
    private readonly useDefault: boolean;
    private readonly shouldFix: boolean;
    private readonly maxWarnings: number = -1;
    private config: ESLint.Options;
    private linterInstance: ESLint;

    constructor({verbose, fix, useDefault, maxWarnings}: LintOptions) {
        this.visualPath = process.cwd()
        this.rootPath = getRootPath();
        this.isVerboseMode = verbose;
        this.useDefault = useDefault;
        this.shouldFix = fix;
        this.maxWarnings = maxWarnings;

        this.prepareConfig();
        this.linterInstance = new ESLint(this.config);
    }

    /**
     * Runs lint validation in the visual folder
     */
    public async runLintValidation() {
        ConsoleWriter.info("Running lint check...");
        // By default it will lint all files in the src of current working directory
        const results = await this.linterInstance.lintFiles("src/");

        if (this.shouldFix) {
            await this.fixErrors(results);
        }
        await this.outputResults(results);
        ConsoleWriter.info("Lint check completed.");
    }
    
    private async fixErrors(results: ESLint.LintResult[]) {
        ConsoleWriter.info("Lint fixing errors...");
        await ESLint.outputFixes(results);
    }

    private async outputResults(results: ESLint.LintResult[]) {
        if (this.isVerboseMode) {
            const formatter = await this.linterInstance.loadFormatter("stylish");
            const formattedResults = await formatter.format(results);
            console.log(formattedResults)
        } else {
            const filteredResults = ESLint.getErrorResults(results);
            // get total amount of errors and warnings in all elements of filteredResults
            const totalErrors = filteredResults.reduce((acc, curr) => acc + curr.errorCount, 0);
            const totalWarnings = filteredResults.reduce((acc, curr) => acc + curr.warningCount, 0);
            if (totalErrors > 0 || totalWarnings > 0) {
                ConsoleWriter.error(`Linter found ${totalErrors} errors and ${totalWarnings} warnings. Run with --verbose flag to see details.`)
            }
            if (
                this.maxWarnings > -1
                && (totalWarnings > this.maxWarnings || totalErrors > this.maxWarnings)
            ) {
                ConsoleWriter.error(`Linter found ${totalWarnings} warnings and ${totalErrors} errors, which exceeds the maximum allowed warnings of ${this.maxWarnings}.`);
                process.exit(1);
            }
        }   
    }

    private prepareConfig() {
        const eslintConfigExtensions = [".js", ".mjs", ".cjs"];
        this.config = {
            fix: this.shouldFix,
        }
        if (
            this.useDefault
            || !eslintConfigExtensions.some(el => fs.existsSync(path.join(this.visualPath, `eslint.config${el}`)))
        ) {
            ConsoleWriter.warning("Using recommended eslint config.")
            this.config.overrideConfig = powerbiPlugin.configs.recommended;
            this.config.overrideConfigFile = true;
        }
    }
}