/**
 * With standard $lookup syntax, the "from" collection is always interpreted to be in the same
 * database the aggregate command is run on. Additionally, the merging is always done on the primary
 * shard for the database.
 *
 * This tests alternative $lookup syntax that supports reading from an unsharded collection that has
 * identical contents across all shards (specifically config.cache.chunks.* namespaces). With the
 * alternative syntax, $lookup behavior changes and it is run locally on each shard rather than
 * merged on the primary shard for the database.
 *
 * Alternative $lookup syntax:
 *        {$lookup: {from: {db:<>, coll:<>},...}}
 *
 * @tags: [
 *   requires_fcv_47
 * ]
 */
(function() {
"use strict";

load("jstests/aggregation/extras/utils.js");  // For assertErrorCode.
load("jstests/libs/discover_topology.js");    // For findNonConfigNodes.
load("jstests/libs/profiler.js");             // For profilerHasSingleMatchingEntryOrThrow.
// For flushRoutersAndRefreshShardMetadata.
load('jstests/sharding/libs/sharded_transactions_helpers.js');

const st = new ShardingTest({shards: 2});
const dbName = jsTestName();
const collName = "foo";

const shard0DB = st.shard0.getDB(dbName);
const shard1DB = st.shard1.getDB(dbName);
const sourceCollection = st.s0.getDB(dbName)[collName];

// $lookup alternative syntax only supports reading 'from' config.cache.chunks.* namespaces.
const invalidLookups = [
    {
        $lookup: {
            from: {db: "config", coll: "validDB.WithInvalid.collection"},
            localField: "x",
            foreignField: "_id.x",
            as: "results",
        }
    },
    {
        $lookup: {
            from: {db: "wrongDB", coll: "cache.chunks.test.foo"},
            localField: "x",
            foreignField: "_id.x",
            as: "results",
        }
    },
    {
        $lookup: {
            from: {db: "config", coll: "validDB.LetLookup.invalidCollectionName"}, 
            let: {x_field: "$x"},
            pipeline: [
                {$match: {$expr: { $eq: ["$_id.x", "$$x_field"]}}}
            ],
            as: "results",
        }
    },
    {
        $lookup: {
            from: {db: "wrongDBWithLet", coll: "cache.chunks.test.foo"}, 
            let: {x_field: "$x"},
            pipeline: [
                {$match: {$expr: { $eq: ["$_id.x", "$$x_field"]}}}
            ],
            as: "results",
        }
    }
];

invalidLookups.forEach((testCase) => {
    assertErrorCode(sourceCollection,
                    [testCase],
                    ErrorCodes.FailedToParse,
                    `Expected $lookup to fail. Original command: ${tojson(testCase)}`);
});

// Sets up the data for $lookup on config.cache.chunks* namespaces.
const setUp = () => {
    sourceCollection.drop();
    // Set up sourceCollection to be sharded on {x:1} and to have the following distribution:
    //      shard0: [MinKey, 0)
    //      shard1: [0, MaxKey)
    st.shardColl(sourceCollection, {x: 1}, {x: 0}, {x: 0}, dbName);

    // Insert a corresponding entry in sourceCollection for each document in
    // config.cache.chunks.dbName.collName.
    assert.commandWorked(sourceCollection.insert({x: MinKey}));
    assert.commandWorked(sourceCollection.insert({x: 0}));

    const ns = dbName + "." + collName;
    flushRoutersAndRefreshShardMetadata(st, {ns});
};

const nodeList = DiscoverTopology.findNonConfigNodes(st.s);

// Tests that $lookup from config.cache.chunks.* yields the expected results.
const testLookupFromConfigCacheChunks = (lookupAgg) => {
    const isShardedLookupEnabled = st.s.adminCommand({getParameter: 1, featureFlagShardedLookup: 1})
                                       .featureFlagShardedLookup.value;

    jsTestLog(`Running test on lookup: ${tojson(lookupAgg)} with featureFlagShardedLookup: ${
        isShardedLookupEnabled}`);

    const results = sourceCollection.aggregate(lookupAgg).toArray();
    results.forEach((res) => {
        assert.eq(res.results.length, 1, `Failed with results ${tojson(results)}`);
    });
};

setUp();
const lookupBasic = {
    $lookup: {
        from: {db: "config", coll: `cache.chunks.${dbName}.${collName}`},
        localField: "x",
        foreignField: "_id.x",
        as: "results",
    }
};
testLookupFromConfigCacheChunks(lookupBasic);

const lookupLet = {
    $lookup: {
        from: {db: "config", coll: `cache.chunks.${dbName}.${collName}`},
        let: {x_field: "$x"},
        pipeline: [
            {$match: {$expr: { $eq: ["$_id.x", "$$x_field"]}}}
        ],
        as: "results",
    }
};
testLookupFromConfigCacheChunks(lookupLet);
st.stop();
}());
