<?php

declare(strict_types=1);

namespace LaraGrid\Query;

use Illuminate\Contracts\Session\Session;

/**
 * What: The default QueryStore — keeps each grid's live query state in the Laravel session
 *       under `laragrid.query.{key}`.
 *
 * Why:  ->persistQuery('session') promises exactly the session's lifetime: the state survives a
 *       reload, a full-page navigation away and back, and a second tab, but dies at logout or
 *       session expiry with no cleanup job and no stale rows in a preferences table. The session
 *       is also the operator scope — there is no cross-user reach to fence off, unlike the
 *       server-side view store. Dots in a key are flattened because Laravel's session helpers
 *       treat them as nesting, which would let one grid's key bury another's entry.
 *
 * When: Bound to QueryStore by LaraGridServiceProvider; resolved by ConfigSerializer (read) and
 *       WithLaraGrid::gridFetch (write).
 */
class SessionQueryStore implements QueryStore
{
    public const PREFIX = 'laragrid.query.';

    public function __construct(private readonly Session $session) {}

    /**
     * @return array<string, mixed>
     */
    public function get(string $key): array
    {
        $stored = $this->session->get($this->sessionKey($key));

        return is_array($stored) ? $stored : [];
    }

    /**
     * @param  array<string, mixed>  $state
     */
    public function put(string $key, array $state): void
    {
        $this->session->put($this->sessionKey($key), $state);
    }

    public function forget(string $key): void
    {
        $this->session->forget($this->sessionKey($key));
    }

    /**
     * The namespaced session key for a grid's persistence key.
     */
    protected function sessionKey(string $key): string
    {
        return self::PREFIX.str_replace('.', '_', $key);
    }
}
