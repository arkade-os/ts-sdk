const esbuild = require('esbuild');

async function build(options = {}) {
    const {
        watch = false,
        production = process.env.NODE_ENV === 'production'
    } = options;

    const commonConfig = {
        bundle: true,
        format: 'esm',
        target: ['es2020'],
        platform: 'browser',
        sourcemap: !production,
        minify: production,
        define: {
            'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development')
        },
        logLevel: 'info',
        treeShaking: true,
        legalComments: production ? 'none' : 'inline',
        drop: production ? ['console', 'debugger'] : [],
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
            entryPoints: ['src/sw/service.ts'],
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
    watch: args.includes('--watch'),
    production: args.includes('--production') || process.env.NODE_ENV === 'production'
};

build(options); 