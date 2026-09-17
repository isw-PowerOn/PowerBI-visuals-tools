"use strict";

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import webpack from 'webpack';
import util from 'util';
import { createRequire } from 'node:module';
const exec = util.promisify(processExec);
const execFile = util.promisify(processExecFile);
import { exec as processExec, execFile as processExecFile } from 'child_process';
import lodashCloneDeep from 'lodash.clonedeep';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import { PowerBICustomVisualsWebpackPlugin, LocalizationLoader } from 'powerbi-visuals-webpack-plugin';
import ConsoleWriter from './ConsoleWriter.js';
import { resolveCertificate } from "./CertificateTools.js";
import { readJsonFromRoot, readJsonFromVisual } from './utils.js'

const config = await readJsonFromRoot('config.json');
const npmPackage = await readJsonFromRoot('package.json');
const moduleResolver = createRequire(import.meta.url);

const visualPlugin = "visualPlugin.ts";
const encoding = "utf8";

export interface WebpackOptions {
    devMode: boolean;
    generateResources: boolean;
    generatePbiviz: boolean;
    minifyJS: boolean;
    minify: boolean;
    stats: boolean;
    provideJquery?: boolean;
    cache?: boolean;
    compression?: number;
    devtool?: string;
    devServerPort?: number;
    fast?: boolean;
    skipApiCheck?: boolean;
    ts6?: boolean;
    allLocales?: boolean;
    pbivizFile?: string;
    certificationAudit?: boolean;
    certificationFix?: boolean;
}

export default class WebPackWrap {
    private pbiviz;
    private webpackConfig;

    static async prepareFoldersAndFiles(visualPackage) {
        const tmpFolder = path.join(visualPackage.basePath, ".tmp");
        const precompileFolder = path.join(visualPackage.basePath, config.build.precompileFolder);
        const dropFolder = path.join(visualPackage.basePath, config.build.dropFolder);
        const packageDropFolder = path.join(visualPackage.basePath, config.package.dropFolder);
        const visualPluginFile = path.join(visualPackage.basePath, config.build.precompileFolder, visualPlugin);
        await fs.ensureDir(tmpFolder);
        await fs.ensureDir(precompileFolder);
        await fs.ensureDir(dropFolder);
        await fs.ensureDir(packageDropFolder);
        await fs.createFile(visualPluginFile);
    }

    static loadAPIPackage() {
        const apiPath = path.join(process.cwd(), "node_modules", "powerbi-visuals-api");
        const doesAPIExist = fs.pathExistsSync(apiPath);
        if (!doesAPIExist) {
            ConsoleWriter.error(`Can't find powerbi-visuals-api package`);
            process.exit(1);
        }
        return import("file://" + path.join(apiPath, "index.js"));
    }

    async installAPIpackage() {
        const apiVersion = this.pbiviz.apiVersion ? `~${this.pbiviz.apiVersion}` : "latest";
        try {
            ConsoleWriter.info(`Installing API: ${apiVersion}...`);
            const {
                stdout,
                stderr
            } = await exec(`npm install --save powerbi-visuals-api@${apiVersion}`);
            if (stdout) ConsoleWriter.info(stdout);
            if (stderr) ConsoleWriter.warning(stderr);
            return true;
        } catch (ex) {
            if (ex.message.indexOf("No matching version found for powerbi-visuals-api") !== -1) {
                throw new Error(`Error: Invalid API version: ${apiVersion}`);
            }
            ConsoleWriter.error(`npm install powerbi-visuals-api@${apiVersion} failed`);
            return false;
        }
    }

    getTypeScript7ConfigPath(visualPackage) {
        return path.join(visualPackage.basePath, ".tmp", "ts7config.json");
    }

    async compileTypeScript7(visualPackage, tsconfig) {
        const temporaryConfigPath = this.getTypeScript7ConfigPath(visualPackage);
        const visualPluginPath = path.join(visualPackage.basePath, config.build.precompileFolder, visualPlugin);
        const configuredFiles = tsconfig.files.map(file =>
            path.relative(path.dirname(temporaryConfigPath), path.resolve(visualPackage.basePath, file))
        );

        const temporaryConfig = {
            extends: path.relative(path.dirname(temporaryConfigPath), path.join(visualPackage.basePath, "tsconfig.json")),
            compilerOptions: {
                outDir: "./ts7-build",
                rootDir: "..",
                noEmit: false,
                sourceMap: true,
                incremental: true,
                tsBuildInfoFile: "./ts7-build/.tsbuildinfo"
            },
            files: [
                ...configuredFiles,
                path.relative(path.dirname(temporaryConfigPath), visualPluginPath)
            ]
        };
        const existingConfig = await fs.pathExists(temporaryConfigPath)
            ? await fs.readJson(temporaryConfigPath)
            : undefined;
        if (JSON.stringify(existingConfig) !== JSON.stringify(temporaryConfig)) {
            await fs.writeJson(temporaryConfigPath, temporaryConfig);
        }

        const compilerPackagePath = moduleResolver.resolve("@typescript/native/package.json");
        const compilerPath = path.join(path.dirname(compilerPackagePath), "bin", "tsc");
        await execFile(process.execPath, [compilerPath, "--project", temporaryConfigPath], {
            cwd: visualPackage.basePath
        });
    }

    configureTypeScript7Precompilation(visualPackage, tsconfig) {
        this.webpackConfig.plugins.push({
            apply: (compiler: webpack.Compiler) => {
                compiler.hooks.beforeRun.tapPromise(
                    "CompileTypeScript7",
                    () => this.compileTypeScript7(visualPackage, tsconfig)
                );
                compiler.hooks.watchRun.tapPromise(
                    "CompileTypeScript7",
                    () => {
                        const changedFiles = compiler.modifiedFiles;
                        const temporaryPath = path.join(visualPackage.basePath, ".tmp");
                        const onlyGeneratedFilesChanged = changedFiles?.size > 0
                            && [...changedFiles].every(file => {
                                const relativePath = path.relative(temporaryPath, file);
                                return !relativePath
                                    || (!relativePath.startsWith(`..${path.sep}`)
                                        && relativePath !== ".."
                                        && !path.isAbsolute(relativePath));
                            });

                        return onlyGeneratedFilesChanged
                            ? Promise.resolve()
                            : this.compileTypeScript7(visualPackage, tsconfig);
                    }
                );
                compiler.hooks.afterCompile.tap("WatchTypeScriptSources", (compilation) => {
                    compilation.contextDependencies.add(path.join(visualPackage.basePath, "src"));
                });
            }
        });
    }

    configureTypeScript7DependencyResolution(visualPackage) {
        const outputPath = path.join(visualPackage.basePath, ".tmp", "ts7-build");
        this.webpackConfig.plugins.push(
            new webpack.NormalModuleReplacementPlugin(/./, resource => {
                // TS emits JavaScript only; resolve missing static dependencies from the source project.
                const relativeContext = path.relative(outputPath, resource.context);
                const isGeneratedContext = !relativeContext.startsWith(`..${path.sep}`)
                    && relativeContext !== ".."
                    && !path.isAbsolute(relativeContext);

                if (!isGeneratedContext) {
                    return;
                }

                if (resource.request.includes("!")) {
                    return;
                }

                const originalContext = path.join(visualPackage.basePath, relativeContext);
                if (!resource.request.startsWith(".")) {
                    resource.context = originalContext;
                    return;
                }

                const generatedRequest = path.resolve(resource.context, resource.request);
                if (fs.existsSync(generatedRequest)) {
                    return;
                }

                const originalRequest = path.resolve(
                    visualPackage.basePath,
                    path.relative(outputPath, generatedRequest)
                );
                if (fs.existsSync(originalRequest)) {
                    resource.request = originalRequest;
                }
            })
        );
    }

    enableOptimization() {
        this.webpackConfig.mode = "production";
        this.webpackConfig.optimization.concatenateModules = false;
        this.webpackConfig.optimization.minimize = true;
        this.webpackConfig.resolve.alias["@vizlib/webix-pro$"] = path.resolve(process.cwd(), 'node_modules/@vizlib/webix-pro/webix.min.js');
    }

    async configureDevServer(visualPackage, port = 8080) {
        const options = await resolveCertificate();

        this.webpackConfig.devServer = {
            ...this.webpackConfig.devServer,
            hot: false,
            port,
            static: {
                directory: path.join(visualPackage.basePath, config.build.dropFolder),
                publicPath: config.server.assetsRoute
            },
            server: {
                type: 'https',
                options: {
                    key: options.key,
                    cert: options.cert,
                    pfx: options.pfx,
                    passphrase: options.passphrase
                }
            }
        };
    }

    configureVisualPlugin(options, tsconfig, visualPackage) {
        this.webpackConfig.output.path = path.join(visualPackage.basePath, config.build.dropFolder);
        this.webpackConfig.output.filename = "[name]";
        const visualPluginPath = options.ts6 ? path.join(process.cwd(), config.build.precompileFolder, visualPlugin) : path.join(visualPackage.basePath, ".tmp", "ts7-build", config.build.precompileFolder, visualPlugin.replace(/\.ts$/, ".js"));
        this.webpackConfig.watchOptions.ignored.push(visualPluginPath);
        this.webpackConfig.entry = {
            "visual.js": [visualPluginPath]
        };
        this.webpackConfig.output.library = `${this.pbiviz.visual.guid}${options.devMode ? "_DEBUG" : ""}`;
        this.webpackConfig.output.libraryTarget = 'var';
    }

    async getEnvironmentDetails() {
        const env = {
            nodeVersion: process.versions.node,
            osPlatform: await os.platform(),
            osVersion: await os.version ?? "undefined",
            osReleaseVersion: await os.release(),
            toolsVersion: npmPackage.version
        };
        return env;
    }

    async configureCustomVisualsWebpackPlugin(visualPackage, options, tsconfig) {
        if (options.skipApiCheck) {
            ConsoleWriter.warning(`Skipping API check. Tools started with --skipApi flag.`);
        } else {
            await this.configureAPIVersion()
        }

        const api = await WebPackWrap.loadAPIPackage();
        const dependenciesPath = typeof this.pbiviz.dependencies === "string" && path.join(process.cwd(), this.pbiviz.dependencies);
        let pluginConfiguration = {
            ...lodashCloneDeep(visualPackage.pbivizConfig),

            apiVersion: api.version,
            capabilitiesSchema: api.schemas.capabilities,
            pbivizSchema: api.schemas.pbiviz,
            stringResourcesSchema: api.schemas.stringResources,
            dependenciesSchema: api.schemas.dependencies,

            customVisualID: `CustomVisual_${this.pbiviz.visual.guid}`.replace(/[^\w\s]/gi, ''),
            devMode: options.devMode,
            generatePbiviz: options.generatePbiviz,
            generateResources: options.generateResources,
            minifyJS: options.minifyJS,
            dependencies: fs.existsSync(dependenciesPath) ? this.pbiviz.dependencies : null,
            modules: typeof tsconfig.compilerOptions.outDir !== "undefined",
            visualSourceLocation: path.posix.relative(config.build.precompileFolder, tsconfig.files[0]).replace(/(\.ts)x|\.ts/, ""),
            pluginLocation: path.join(config.build.precompileFolder, "visualPlugin.ts"),
            compression: options.compression,
            certificationAudit: options.certificationAudit,
            certificationFix: options.certificationFix,
        };
        return pluginConfiguration;
    }

    async configureAPIVersion() {
        //(?<=powerbi-visuals-api@) - positive look-behind to find version installed in visual and get 3 level version.
        const regexFullVersion = /(?<=powerbi-visuals-api@)((?:\d+\.?){1,3})/g;
        //get only first 2 parts of version
        const regexMajorVersion = /\d+(?:\.\d+)?/;
        let listResults;
        try {
            listResults = (await exec('npm list powerbi-visuals-api version')).stdout
        } catch (error) {
            listResults = error.stdout;
        }
        const installedAPIVersion = listResults.match(regexFullVersion)?.[0] ?? "not found";
        const doesAPIExist = fs.pathExistsSync(path.join(process.cwd(), "node_modules", "powerbi-visuals-api"));

        // if the powerbi-visual-api package wasn't installed install the powerbi-visual-api,
        // with version from apiVersion in pbiviz.json or the latest API, if apiVersion is absent in pbiviz.json
        const isAPIConfigured = doesAPIExist && installedAPIVersion && this.pbiviz.apiVersion
        if (!isAPIConfigured || this.pbiviz.apiVersion.match(regexMajorVersion)[0] != installedAPIVersion.match(regexMajorVersion)[0]) {
            ConsoleWriter.warning(`installed "powerbi-visuals-api" version - "${installedAPIVersion}", is not match with the version specified in pbviz.json - "${this.pbiviz.apiVersion}".`);
            await this.installAPIpackage();
        }
    }

    async appendPlugins(options: WebpackOptions, visualPackage, tsconfig) {
        const pluginConfiguration = await this.configureCustomVisualsWebpackPlugin(visualPackage, options, tsconfig);

        let statsFilename = config.build.stats.split("/").pop();
        const statsLocation = config.build.stats.split("/").slice(0, -1).join(path.sep);
        statsFilename = statsFilename?.split(".").slice(0, -1).join(".");
        statsFilename = `${statsFilename}.${options.devMode ? "dev" : "prod"}.html`;

        if (options.stats) {
            this.webpackConfig.plugins.push(
                new BundleAnalyzerPlugin({
                    reportFilename: path.join(statsLocation, statsFilename),
                    openAnalyzer: false,
                    analyzerMode: `static`
                })
            );
        }
        this.webpackConfig.plugins.push(
            new PowerBICustomVisualsWebpackPlugin(pluginConfiguration),
            {
                apply: (compiler: webpack.Compiler) => {
                    compiler.hooks.afterCompile.tap('AddCapabilitiesWatch', (compilation) => {
                        const capabilitiesPath = path.resolve(process.cwd(), this.pbiviz.capabilities);
                        compilation.fileDependencies.add(capabilitiesPath);
                    });
                }
            }
        );

        if (options.ts6) {

        }

        if (options.provideJquery) {
            this.webpackConfig.plugins.push(
                new webpack.ProvidePlugin({
                    $: "jquery",
                    jQuery: "jquery",
                    "window.jQuery": "jquery",
                })
            );
        }
    }

    async configureLoaders({
        includeAllLocales = false,
                               typescript7OutputPath,
                               ts6,
    }) {
        if (ts6) {
            this.webpackConfig.module.rules.push({
                test: /(\.ts)x?$/,
                use: [
                    {
                        loader: "ts-loader",
                        options: {
                            transpileOnly: false,
                            experimentalWatchApi: false
                        }
                    }
                ]
            });
        } else {
            this.webpackConfig.module.rules.push({
                enforce: "pre",
                include: typescript7OutputPath,
                test: /\.js$/,
                use: ["source-map-loader"]
            });
        }

        if(!includeAllLocales){
            this.webpackConfig.module.rules.push({ 
                test: /powerbiGlobalizeLocales\.js$/, // path to file with all locales declared in formattingutils
                loader: LocalizationLoader
            });
        }
    }

    async prepareWebPackConfig(visualPackage, options: WebpackOptions, tsconfig) {
        this.webpackConfig = Object.assign({}, await import('./webpack.config.js')).default;
        
        // Set webpack mode based on devMode
        if (options.devMode) {
            this.webpackConfig.mode = "development";
        }
        
        if (options.minifyJS) {
            this.enableOptimization();
        }

        if (options.cache) {
            this.webpackConfig.cache = options.cache;
        }

        if (options.devtool) {
            this.webpackConfig.devtool = options.devtool;
        }

        await this.appendPlugins(options, visualPackage, tsconfig);
        await this.configureDevServer(visualPackage, options.devServerPort);
        await this.configureVisualPlugin(options, tsconfig, visualPackage);
        if (!options.ts6) {
            this.configureTypeScript7Precompilation(visualPackage, tsconfig);
            this.configureTypeScript7DependencyResolution(visualPackage);
            this.webpackConfig.experiments = {
                typescript: true,
            }
        }

        await this.configureLoaders({
            includeAllLocales: options.allLocales,
            typescript7OutputPath: path.join(visualPackage.basePath, ".tmp", "ts7-build"),
            ts6: options.ts6
        });


        return this.webpackConfig;
    }

    async assemblyExternalJSFiles(visualPackage) {
        const externalJSFilesContent = "";
        const externalJSFilesPath = path.join(visualPackage.basePath, config.build.precompileFolder, "externalJS.js");
        await fs.writeFile(
            externalJSFilesPath,
            externalJSFilesContent, {
            encoding: encoding
        });

        return externalJSFilesPath;
    }

    async generateWebpackConfig(visualPackage, options: WebpackOptions = {
        devMode: false,
        provideJquery: false,
        generateResources: false,
        generatePbiviz: false,
        minifyJS: true,
        minify: true,
        devServerPort: 8080,
        cache: false,
        fast: false,
        compression: 0,
        stats: false,
        skipApiCheck: false,
        allLocales: false,
        pbivizFile: 'pbiviz.json',
        certificationAudit: false,
        certificationFix: false,
    }) {
        const tsconfig = await readJsonFromVisual('tsconfig.json');
        this.pbiviz = await readJsonFromVisual(options.pbivizFile);

        const capabilitiesPath = this.pbiviz.capabilities;
        visualPackage.pbivizConfig.capabilities = capabilitiesPath;

        const dependenciesPath = this.pbiviz.dependencies && path.join(process.cwd(), this.pbiviz.dependencies);
        const dependenciesFile = fs.existsSync(dependenciesPath) && JSON.parse(fs.readFileSync(dependenciesPath));
        visualPackage.pbivizConfig.dependencies = typeof dependenciesFile === 'object' ? dependenciesFile : {};

        await WebPackWrap.prepareFoldersAndFiles(visualPackage);

        const webpackConfig = await this.prepareWebPackConfig(visualPackage, options, tsconfig);

        return webpackConfig;
    }
}
