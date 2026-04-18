import esbuild from 'esbuild';

async function build(options = {}) {
    const { watch = false } = options;

    // Fail if running in production
    if (process.env.NODE_ENV === 'production') {
        throw new Error('This build script should not be run in production mode');
    }

    const commonConfig = {
        bundle: true,
        format: 'esm',
        target: ['es2020'],
        platform: 'browser',
        sourcemap: true,
        minify: false,
        define: {
            'process.env.NODE_ENV': JSON.stringify('development')
        },
        logLevel: 'info',
        treeShaking: true,
        legalComments: 'inline',
        metafile: true
    };

    try {
        // Build main SDK bundle
        const mainCtx = await esbuild.context({
            ...commonConfig,
            entryPoints: ['src/index.ts'],
            outfile: 'dist/browser/index.js',
        });

        // Build service worker bundle
        const swCtx = await esbuild.context({
            ...commonConfig,
            entryPoints: ['test/serviceWorker/service.ts'],
            outfile: 'dist/browser/sw.js',
        });

        if (watch) {
            console.log('Watching for changes...');
            await Promise.all([
                mainCtx.watch(),
                swCtx.watch()
            ]);
        } else {
            const [mainResult, swResult] = await Promise.all([
                mainCtx.rebuild(),
                swCtx.rebuild()
            ]);
            
            console.log('Browser bundles built successfully');
            
            // Log build meta information
            if (mainResult.metafile) {
                console.log('\nMain bundle analysis:');
                console.log(await esbuild.analyzeMetafile(mainResult.metafile));
            }
            
            if (swResult.metafile) {
                console.log('\nService worker bundle analysis:');
                console.log(await esbuild.analyzeMetafile(swResult.metafile));
            }
            
            await Promise.all([
                mainCtx.dispose(),
                swCtx.dispose()
            ]);
        }
    } catch (error) {
        console.error('Error building browser bundles:', error);
        process.exit(1);
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
    watch: args.includes('--watch')
};

build(options); 