/**
 * What: The mode-independent gridExport RPC driver. It sends only current query intents and
 *       emits download lifecycle events; the server independently rebuilds trusted rows.
 * Why: Readonly in-memory grids with ->exportRows() need downloads without acquiring a
 *      PageSource (which would incorrectly make their display use gridFetch).
 * When: Used directly by GridCore for exportRows-backed display grids and inherited by the
 *       query-backed PageSource.
 */
export default class ExportSource {
    constructor(store, bus, wire) {
        this.store = store;
        this.bus = bus;
        this.wire = wire;
        this.exporting = false;
    }

    /** Download the current sort/search/filter view through the server-authoritative RPC. */
    export(format) {
        if (this.exporting || typeof this.wire.gridExport !== 'function') {
            return Promise.resolve();
        }
        const query = { ...this.store.query };
        delete query.page;
        delete query.perPage;

        this.exporting = true;
        this.bus.emit('export:started', { format });
        return this.wire
            .gridExport(this.store.name, format, query)
            .then(() => {
                this.exporting = false;
                this.bus.emit('export:done', { format });
            })
            .catch((error) => {
                this.exporting = false;
                this.bus.emit('export:error', { format, error });
            });
    }
}
