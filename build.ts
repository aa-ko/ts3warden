import { bunPluginPino } from 'bun-plugin-pino';

await Bun.build({
    entrypoints: ['./index.ts'],
    outdir: './dist',
    bytecode: false, // Unsupported when using esm target format.
    format: "esm",
    minify: true,
    sourcemap: "inline",
    target: "bun",
    plugins: [
        bunPluginPino({
            transports: ['pino-pretty'], // any additional transports you may be using
            // logging?: "default" | "plain" | "quiet"
        }),
    ],
});