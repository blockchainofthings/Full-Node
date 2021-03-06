var async = require('async')
var CCTransaction = require('cc-transaction')
var getAssetsOutputs = require('cc-get-assets-outputs')
var bitcoinjs = require('bitcoinjs-lib')
var bufferReverse = require('buffer-reverse')
var _ = require('lodash')
var toposort = require('toposort')
var redisClient = require('redis')
var bitcoinRpc = require('bitcoin-async')
var events = require('events')
var path = require('path-extra')
var BigNumber = require('bignumber.js');

var mainnetFirstColoredBlock = 364548
var testnetFirstColoredBlock = 462320

var blockStates = {
  NOT_EXISTS: 0,
  GOOD: 1,
  FORKED: 2
}

var label = 'cc-full-node'

var ParseControl = require(path.join(__dirname, '/../src/ParseControl.js'))
var parseControl


module.exports = function (args) {
  parseControl = new ParseControl(!!args.parser.parseControlLoggingOn)

  args = args || {}
  var network = args.network || 'testnet'
  var bitcoinNetwork = (network === 'mainnet') ? bitcoinjs.networks.bitcoin : bitcoinjs.networks.testnet
  var redisOptions = {
    host: args.redisHost || 'localhost',
    port: args.redisPort || '6379',
    prefix: 'ccfullnode:' + network + ':'
  }
  var redis = redisClient.createClient(redisOptions)

  var bitcoinOptions = {
    host: args.bitcoinHost || 'localhost',
    port: args.bitcoinPort || '18332',
    user: args.bitcoinUser || 'rpcuser',
    pass: args.bitcoinPass || 'rpcpass',
    path: args.bitcoinPath || '/',
    timeout: args.bitcoinTimeout || 30000
  }
  var bitcoin = new bitcoinRpc.Client(bitcoinOptions)

  var emitter = new events.EventEmitter()

  var info = {
    bitcoindbusy: true
  }

  var waitForBitcoind = function (cb) {
    if (!info.bitcoindbusy) return cb()
    return setTimeout(function() {
      console.log('Waiting for bitcoind...')
      bitcoin.cmd('getinfo', [], function (err) {
        if (err) {
          info.error = {}
          if (err.code) {
            info.error.code = err.code
          }
          if (err.message) {
            info.error.message = err.message
          }
          if (!err.code && !err.message) {
            info.error = err
          }
          return waitForBitcoind(cb)
        }
        delete info.error
        info.bitcoindbusy = false
        cb()
      })
    }, 5000)
  }

  var getNextBlockHeight = function (cb) {
    redis.hget('blocks', 'lastBlockHeight', function (err, lastBlockHeight) {
      if (err) return cb(err)
      lastBlockHeight = lastBlockHeight || ((network === 'mainnet' ? mainnetFirstColoredBlock : testnetFirstColoredBlock) - 1)
      lastBlockHeight = parseInt(lastBlockHeight)
      cb(null, lastBlockHeight + 1)
    })
  }

  var getNextBlock = function (height, cb) {
    bitcoin.cmd('getblockhash', [height], function (err, hash) {
      if (err) {
        if (err.code && err.code === -8) {
          return cb(null, null)
        }
        return cb(err)
      }
      bitcoin.cmd('getblock', [hash, false], function (err, rawBlock) {
        if (err) return cb(err)
        var block = bitcoinjs.Block.fromHex(rawBlock)
        block.height = height
        block.hash = hash
        block.previousblockhash = bufferReverse(block.prevHash).toString('hex')

        var transactions = [];
        block.mapTransaction = {};

        block.transactions.forEach(function (transaction) {
          var decTransact = decodeRawTransaction(transaction);
          transactions.push(decTransact);
          block.mapTransaction[decTransact.txid] = decTransact;
        });

        block.transactions = transactions;

        cb(null, block)
      })
    })
  }

  var checkNextBlock = function (block, cb) {
    if (!block) return cb(null, blockStates.NOT_EXISTS, block)
    redis.hget('blocks', block.height - 1, function (err, hash) {
      if (!hash || hash === block.previousblockhash) return cb(null, blockStates.GOOD, block)
      cb(null, blockStates.FORKED, block)
    })
  }

  var revertBlock = function (blockHeight, cb) {
    console.log('forking block', blockHeight)
    updateLastBlock(blockHeight - 1, cb)
  }

  var conditionalParseNextBlock = function (state, block, cb) {
    if (state === blockStates.NOT_EXISTS) {
      return mempoolParse(cb)
    }
    // console.log('block', block.hash, block.height, 'txs:', block.transactions.length, 'state', state)
    if (state === blockStates.GOOD) {
      return parseNewBlock(block, cb)
    }
    if (state === blockStates.FORKED) {
      return revertBlock(block.height - 1, cb)
    }
    cb('Unknown block state')
  }

  var checkVersion = function (hex) {
    var version = hex.toString('hex').substring(0, 4)
    return (version.toLowerCase() === '4343')
  }

  var getColoredData = function (transaction) {
    var coloredData = null
    transaction.vout.some(function (vout) {
      if (!vout.scriptPubKey || !vout.scriptPubKey.type === 'nulldata') return null
      var hex = vout.scriptPubKey.asm.substring('OP_RETURN '.length)
      if (checkVersion(hex)) {
        try {
          coloredData = CCTransaction.fromHex(hex).toJson()
        } catch (e) {
          console.log('Invalid CC transaction.')
        }
      }
      return coloredData
    })
    return coloredData
  }

  var getPreviousOutputs = function(transaction, cb) {
    var prevTxs = []

    transaction.vin.forEach(function(vin) {
      prevTxs.push(vin)
    })

    var prevOutsBatch = prevTxs.map(function(vin) { return { 'method': 'getrawtransaction', 'params': [vin.txid] } })
    bitcoin.cmd(prevOutsBatch, function (rawTransaction, cb) {
      var prevTx = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
      var txid = prevTx.id
      prevTxs.forEach(function(vin) {
        vin.previousOutput = prevTx.vout[vin.vout]
        if(vin.previousOutput && vin.previousOutput.scriptPubKey && vin.previousOutput.scriptPubKey.addresses) {
          vin.previousOutput.addresses = vin.previousOutput.scriptPubKey.addresses
        }
      })
      cb()
    }, function(err) {
      if (err) return cb(err)
      transaction.fee = transaction.vin.reduce(function(sum, vin) {
        if (vin.previousOutput) {
          return sum + vin.previousOutput.value
        }
        return sum
      }, 0) - transaction.vout.reduce(function(sum, vout) { return sum + vout.value }, 0)
      transaction.totalsent = transaction.vin.reduce(function(sum, vin) {
        if (vin.previousOutput) {
          return sum + vin.previousOutput.value
        }
        return sum
      }, 0)
      cb(null, transaction)
    })
  }

  var parseTransaction = function (transaction, utxosChanges, blockHeight, cb) {
    async.each(transaction.vin, function (input, cb) {
      var previousOutput = input.txid + ':' + input.vout
      if (utxosChanges.unused[previousOutput]) {
        input.assets = JSON.parse(utxosChanges.unused[previousOutput])
        return process.nextTick(cb)
      }
      redis.hget('utxos', previousOutput, function (err, assets) {
        if (err) return cb(err)
        input.assets = assets && JSON.parse(assets) || []
        if (input.assets.length) {
          utxosChanges.used[previousOutput] = assets
        }
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      var outputsAssets = getAssetsOutputs(transaction)
      outputsAssets.forEach(function (assets, outputIndex) {
        if (assets && assets.length) {
          utxosChanges.unused[transaction.txid + ':' + outputIndex] = JSON.stringify(assets)
        }
      })
      emitter.emit('newcctransaction', transaction)
      emitter.emit('newtransaction', transaction)
      cb()
    })
  }

  var setTxos = function (utxos, cb) {
    async.each(Object.keys(utxos), function (utxo, cb) {
      var assets = utxos[utxo]
      redis.hmset('utxos', utxo, assets, cb)
    }, cb)
  }

  var updateLastBlock = function (blockHeight, blockHash, timestamp, cb) {
    if (typeof blockHash === 'function') {
      return redis.hmset('blocks', 'lastBlockHeight', blockHeight, blockHash)
    }
    redis.hmset('blocks', blockHeight, blockHash, 'lastBlockHeight', blockHeight, 'lastTimestamp', timestamp, function (err) {
      cb(err)
    })
  }

  var updateUtxosChanges = function (block, utxosChanges, cb) {
    async.waterfall([
      function (cb) {
        var txoutAddresses = {};
        var assetIdAddresses = {};
        var assetIdIssuanceInfo = {};
        var txidTxouts = {};
        var addressTxouts = {};
        var hasTxout = false;

        Object.keys(utxosChanges.unused).forEach(function (txout) {
          hasTxout = true;

          // Get addresses associated with transaction output
          var parts = txout.split(':');
          var txid = parts[0];
          var addresses = block.mapTransaction[txid].vout[parts[1]].scriptPubKey.addresses;

          txoutAddresses[txout] = addresses;

          // Get assets information
          var assetInfos = JSON.parse(utxosChanges.unused[txout]);
          var assetIdAssetInfo = {};

          assetInfos.forEach(function (assetInfo) {
            assetIdAssetInfo[assetInfo.assetId] = assetInfo;
          });

          Object.keys(assetIdAssetInfo).forEach(function (assetId) {
            // Identify addresses associated with assets
            if (!(assetId in assetIdAddresses)) {
              assetIdAddresses[assetId] = txoutAddresses[txout];
            }
            else {
              assetIdAddresses[assetId] = mergeArrays(assetIdAddresses[assetId], txoutAddresses[txout]);
            }

            // Identify issuing transactions associated with assets
            var assetInfo = assetIdAssetInfo[assetId];

            if (!(assetInfo.assetId in assetIdIssuanceInfo)) {
              assetIdIssuanceInfo[assetInfo.assetId] = {};
            }

            assetIdIssuanceInfo[assetInfo.assetId][assetInfo.issueTxid] = {
              divisibility: assetInfo.divisibility,
              lockStatus: assetInfo.lockStatus,
              aggregationPolicy: assetInfo.aggregationPolicy
            };
          });

          // Identify tx outputs associated with transactions
          if (!(txid in txidTxouts)) {
            txidTxouts[txid] = [txout];
          }
          else {
            txidTxouts[txid].push(txout);
          }

          // Identify tx outputs associated with addresses
          addresses.forEach(function(address) {
            if (!(address in addressTxouts)) {
              addressTxouts[address] = [txout];
            }
            else if (addressTxouts[address].indexOf(txout) === -1) {
              addressTxouts[address].push(txout);
            }
          });
        });

        if (hasTxout) {
          async.waterfall([
            function (cb) {
              // Populate asset-addresses hash of local Redis database
              setAssetAddresses(assetIdAddresses, cb);
            },
            function (cb) {
              // Populate asset-issuance hash of local Redis database
              setAssetIssuance(assetIdIssuanceInfo, cb);
            },
            function (cb) {
              // Populate transaction-utxos hash of local Redis database
              setTransactionUtxos(txidTxouts, cb);
            },
            function (cb) {
              // Populate address-utxos hash of local Redis database
              setAddressUtxos(addressTxouts, cb);
            }
          ], cb);
        }
        else {
          cb(null);
        }
      },
      function (cb) {
        setTxos(utxosChanges.unused, cb)
      },
      function (cb) {
        updateLastBlock(block.height, block.hash, block.timestamp, cb)
      }
    ], cb)
  }

  function setAssetAddresses(assetIdAddresses, cb) {
    async.each(Object.keys(assetIdAddresses), function (assetId, cb) {
      redis.hget('asset-addresses', assetId, function (err, addresses) {
        if (err) cb(err);

        if (addresses) {
          var currentAddresses = JSON.parse(addresses);
          var updatedAddresses = mergeArrays(currentAddresses, assetIdAddresses[assetId]);

          if (updatedAddresses.length > currentAddresses.length) {
            redis.hset('asset-addresses', assetId, JSON.stringify(updatedAddresses), cb);
          }
          else {
            cb(null);
          }
        }
        else {
          redis.hset('asset-addresses', assetId, JSON.stringify(assetIdAddresses[assetId]), cb);
        }
      });
    }, cb);
  }

  function setAssetIssuance(assetIdIssuanceInfo, cb) {
    async.each(Object.keys(assetIdIssuanceInfo), function (assetId, cb) {
      redis.hget('asset-issuance', assetId, function (err, issuance) {
        if (err) cb(err);

        var currentIssuance = issuance ? JSON.parse(issuance) : {};

        Object.keys(assetIdIssuanceInfo[assetId]).forEach(function (txid) {
          currentIssuance[txid] = assetIdIssuanceInfo[assetId][txid];
        });

        redis.hset('asset-issuance', assetId, JSON.stringify(currentIssuance), cb);
      });
    }, cb);
  }

  function setTransactionUtxos(txidTxouts, cb) {
    async.each(Object.keys(txidTxouts), function (txid, cb) {
      redis.hget('transaction-utxos', txid, function (err, utxos) {
        if (err) cb(err);

        if (utxos) {
          var currentUtxos = JSON.parse(utxos);
          var updatedUtxos = mergeArrays(currentUtxos, txidTxouts[txid]);

          if (updatedUtxos.length > currentUtxos.length) {
            redis.hset('transaction-utxos', txid, JSON.stringify(updatedUtxos), cb);
          }
          else {
            cb(null);
          }
        }
        else {
          redis.hset('transaction-utxos', txid, JSON.stringify(txidTxouts[txid]), cb);
        }
      });
    }, cb);
  }

  function setAddressUtxos(addressTxouts, cb) {
    async.each(Object.keys(addressTxouts), function (address, cb) {
      redis.hget('address-utxos', address, function (err, utxos) {
        if (err) cb(err);

        if (utxos) {
          var currentUtxos = JSON.parse(utxos);
          var updatedUtxos = mergeArrays(currentUtxos, addressTxouts[address]);

          if (updatedUtxos.length > currentUtxos.length) {
            redis.hset('address-utxos', address, JSON.stringify(updatedUtxos), cb);
          }
          else {
            cb(null);
          }
        }
        else {
          redis.hset('address-utxos', address, JSON.stringify(addressTxouts[address]), cb);
        }
      });
    }, cb);
  }

  function mergeArrays(ar1, ar2) {
    var resultAr = ar1.concat([]);

    ar2.forEach(function (element) {
      if (resultAr.indexOf(element) === -1) {
        resultAr.push(element);
      }
    });

    return resultAr;
  }

  var updateParsedMempoolTxids = function (txids, cb) {
    async.waterfall([
      function (cb) {
        redis.hget('mempool', 'parsed', cb)
      },
      function (parsedMempool, cb) {
        parsedMempool = JSON.parse(parsedMempool || '[]')
        parsedMempool = parsedMempool.concat(txids)
        parsedMempool = _.uniq(parsedMempool)
        redis.hmset('mempool', 'parsed', JSON.stringify(parsedMempool), cb)
      }
    ], function (err) {
      cb(err)
    })
  }

  var updateMempoolTransactionUtxosChanges = function (transaction, utxosChanges, cb) {
    async.waterfall([
      function (cb) {
        var txoutAddresses = {};
        var assetIdAddresses = {};
        var assetIdIssuanceInfo = {};
        var txidTxouts = {};
        var addressTxouts = {};
        var hasTxout = false;

        Object.keys(utxosChanges.unused).forEach(function (txout) {
          hasTxout = true;

          // Get addresses associated with transaction output
          var addresses = transaction.vout[txout.split(':')[1]].scriptPubKey.addresses;

          txoutAddresses[txout] = addresses;

          // Get assets information
          var assetInfos = JSON.parse(utxosChanges.unused[txout]);
          var assetIdAssetInfo = {};

          assetInfos.forEach(function (assetInfo) {
            assetIdAssetInfo[assetInfo.assetId] = assetInfo;
          });

          Object.keys(assetIdAssetInfo).forEach(function (assetId) {
            // Identify addresses associated with assets
            if (!(assetId in assetIdAddresses)) {
              assetIdAddresses[assetId] = txoutAddresses[txout];
            }
            else {
              assetIdAddresses[assetId] = mergeArrays(assetIdAddresses[assetId], txoutAddresses[txout]);
            }

            // Identify issuing transactions associated with assets
            var assetInfo = assetIdAssetInfo[assetId];

            if (!(assetInfo.assetId in assetIdIssuanceInfo)) {
              assetIdIssuanceInfo[assetInfo.assetId] = {};
            }

            assetIdIssuanceInfo[assetInfo.assetId][assetInfo.issueTxid] = {
              divisibility: assetInfo.divisibility,
              lockStatus: assetInfo.lockStatus,
              aggregationPolicy: assetInfo.aggregationPolicy
            };
          });

          // Identify tx outputs associated with transactions
          if (!(transaction.txid in txidTxouts)) {
            txidTxouts[transaction.txid] = [txout];
          }
          else {
            txidTxouts[transaction.txid].push(txout);
          }

          // Identify tx outputs associated with addresses
          addresses.forEach(function(address) {
            if (!(address in addressTxouts)) {
              addressTxouts[address] = [txout];
            }
            else if (addressTxouts[address].indexOf(txout) === -1) {
              addressTxouts[address].push(txout);
            }
          });
        });

        if (hasTxout) {
          async.waterfall([
            function (cb) {
              // Populate asset-addresses hash of local Redis database
              setAssetAddresses(assetIdAddresses, cb);
            },
            function (cb) {
              // Populate asset-issuance hash of local Redis database
              setAssetIssuance(assetIdIssuanceInfo, cb);
            },
            function (cb) {
              // Populate transaction-utxos hash of local Redis database
              setTransactionUtxos(txidTxouts, cb);
            },
            function (cb) {
              // Populate address-utxos hash of local Redis database
              setAddressUtxos(addressTxouts, cb);
            }
          ], cb);
        }
        else {
          cb(null);
        }
      },
      function (cb) {
        setTxos(utxosChanges.unused, cb)
      },
      function (cb) {
        updateParsedMempoolTxids([transaction.txid], cb)
      }
    ], cb)
  }

  var decodeRawTransaction = function (tx) {
    var r = {}
    r['txid'] = tx.getId()
    r['version'] = tx.version
    r['locktime'] = tx.lock_time
    r['hex'] = tx.toHex()
    r['vin'] = []
    r['vout'] = []

    tx.ins.forEach(function (txin) {
        var txid = txin.hash.reverse().toString('hex')
        var n = txin.index
        var seq = txin.sequence
        var hex = txin.script.toString('hex')
        if (n == 4294967295) {
          r['vin'].push({'txid': txid, 'vout': n, 'coinbase' : hex, 'sequence' : seq})
        } else {
          var asm = bitcoinjs.script.toASM(txin.script)
          r['vin'].push({'txid': txid, 'vout': n, 'scriptSig' : {'asm': asm, 'hex': hex}, 'sequence':seq})
        }
    })

    tx.outs.forEach(function (txout, i) {
        var value = txout.value
        var hex = txout.script.toString('hex')
        var asm = bitcoinjs.script.toASM(txout.script)
        var type = bitcoinjs.script.classifyOutput(txout.script)
        var addresses = []
        if (~['pubkeyhash', 'scripthash'].indexOf(type)) {
          addresses.push(bitcoinjs.address.fromOutputScript(bitcoinjs.script.decompile(txout.script), bitcoinNetwork))
        }
        var answer = {'value' : value, 'n': i, 'scriptPubKey': {'asm': asm, 'hex': hex, 'addresses': addresses, 'type': type}}

        r['vout'].push(answer)
    })

    var ccdata = getColoredData(r)
    if (ccdata) {
      r['ccdata'] = [ccdata]
      r['colored'] = true
    }
    return r
  }

  var parseNewBlock = function (block, cb) {
    info.cctimestamp = block.timestamp
    info.ccheight = block.height
    var utxosChanges = {
      used: {},
      unused: {},
      txids: []
    }
    async.eachSeries(block.transactions, function (transaction, cb) {
      utxosChanges.txids.push(transaction.txid)
      var coloredData = getColoredData(transaction)
      if (!coloredData) {
        emitter.emit('newtransaction', transaction)
        return process.nextTick(cb)
      }
      transaction.ccdata = [coloredData]
      parseTransaction(transaction, utxosChanges, block.height, cb)
    }, function (err) {
      if (err) return cb(err)
      updateUtxosChanges(block, utxosChanges, function (err) {
        if (err) return cb(err)
        block.transactions = block.transactions.map(transaction => transaction.txid)
        emitter.emit('newblock', block)
        cb()
      })
    })
  }

  var getMempoolTxids = function (cb) {
    bitcoin.cmd('getrawmempool', [], cb)
  }

  var getNewMempoolTxids = function (mempoolTxids, cb) {
    redis.hget('mempool', 'parsed', function (err, mempool) {
      if (err) return cb(err)
      mempool = mempool || '[]'
      var parsedMempoolTxids = JSON.parse(mempool)
      newMempoolTxids = _.difference(mempoolTxids, parsedMempoolTxids)
      cb(null, newMempoolTxids)
    })
  }

  var getNewMempoolTransaction = function (newMempoolTxids, cb) {
    var commandsArr = newMempoolTxids.map(function (txid) {
      return { method: 'getrawtransaction', params: [txid, 0]}
    })
    var newMempoolTransactions = []
    bitcoin.cmd(commandsArr, function (rawTransaction, cb) {
      var newMempoolTransaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
      newMempoolTransactions.push(newMempoolTransaction)
      cb()
    },
    function (err) {
      cb(err, newMempoolTransactions)
    })
  }

  var orderByDependencies = function (transactions) {
    var txids = {}
    transactions.forEach(function (transaction) {
      txids[transaction.txid] = transaction
    })
    var edges = []
    transactions.forEach(function (transaction) {
      transaction.vin.forEach(function (input) {
        if (txids[input.txid]) {
          edges.push([input.txid, transaction.txid])
        }
      })
    })
    var sortedTxids = toposort.array(Object.keys(txids), edges)
    return sortedTxids.map(function (txid) { return txids[txid] } )
  }

  var parseNewMempoolTransactions = function (newMempoolTransactions, cb) {
    newMempoolTransactions = orderByDependencies(newMempoolTransactions)
    var nonColoredTxids  = []
    async.eachSeries(newMempoolTransactions, function (newMempoolTransaction, cb) {
      var utxosChanges = {
        used: {},
        unused: {}
      }
      var coloredData = getColoredData(newMempoolTransaction)
      if (!coloredData) {
        nonColoredTxids.push(newMempoolTransaction.txid)
        emitter.emit('newtransaction', newMempoolTransaction)
        return process.nextTick(cb)
      }
      newMempoolTransaction.ccdata = [coloredData]
      parseTransaction(newMempoolTransaction, utxosChanges, -1, function (err) {
        if (err) return cb(err)
        updateMempoolTransactionUtxosChanges(newMempoolTransaction, utxosChanges, cb)
      })
    }, function (err) {
      if (err) return cb(err)
      updateParsedMempoolTxids(nonColoredTxids, cb)
    })
  }

  var updateInfo = function (cb) {
    if (info.ccheight && info.cctimestamp) {
      return process.nextTick(cb)
    }
    redis.hmget('blocks', 'lastBlockHeight', 'lastTimestamp', function (err, arr) {
      if (err) return cb(err)
      if (!arr || arr.length < 2) return process.nextTick(cb)
      info.ccheight = arr[0]
      info.cctimestamp = arr[1]
      cb()
    })
  }

  var mempoolParse = function (cb) {
    // console.log('parsing mempool')
    async.waterfall([
      updateInfo,
      getMempoolTxids,
      getNewMempoolTxids,
      getNewMempoolTransaction,
      parseNewMempoolTransactions
    ], cb)
  }

  var finishParsing = function (err)  {
    if (err) console.error(err)
    parseProcedure()
  }

  var importAddresses = function (args, cb) {
    var addresses = args.addresses
    var reindex = args.reindex === 'true' || args.reindex === true
    var newAddresses
    var importedAddresses
    var ended = false

    var endFunc = function () {
      if (!ended) {
        ended = true
        return cb(null, {
          addresses: addresses,
          reindex: reindex,
        })
      }
    }
    async.waterfall([
      function (cb) {
        redis.hget('addresses', 'imported', cb)
      },
      function (_importedAddresses, cb) {
        importedAddresses = _importedAddresses || '[]'
        importedAddresses = JSON.parse(importedAddresses)
        newAddresses = _.difference(addresses, importedAddresses)
        if (reindex && newAddresses.length < 2 || !newAddresses.length) return process.nextTick(cb)
        var commandsArr = newAddresses.splice(0, newAddresses.length - (reindex ? 1 : 0)).map(function (address) {
          return {
            method: 'importaddress',
            params: [address, label, false]
          }
        })
        bitcoin.cmd(commandsArr, function (ans, cb) { return process.nextTick(cb)}, cb)
      },
      function (cb) {
        reindex = false
        if (!newAddresses.length) return process.nextTick(cb)
        reindex = true
        info.bitcoindbusy = true
        bitcoin.cmd('importaddress', [newAddresses[0], label, true], function (err) {
          waitForBitcoind(cb)
        })
        endFunc()
      },
      function (cb) {
        newAddresses = _.difference(addresses, importedAddresses)
        if (!newAddresses.length) return process.nextTick(cb)
        importedAddresses = importedAddresses.concat(newAddresses)
        redis.hmset('addresses', 'imported', JSON.stringify(importedAddresses), function (err) {
          cb(err)
        })
      }
    ], function (err) {
      if (err) return cb(err)
      endFunc()
    })
  }

  var parse = function (addresses, progressCallback) {
    if (typeof addresses === 'function') {
      progressCallback = addresses
      addresses = null
    }
    setInterval(function () {
      emitter.emit('info', info)
      if (progressCallback) {
        progressCallback(info)
      }
    }, 5000);
    if (!addresses || !Array.isArray(addresses)) return parseProcedure()
    importAddresses({addresses: addresses, reindex: true}, parseProcedure)
  }

  var infoPopulate = function (cb) {
    getBitcoindInfo(function (err, newInfo) {
      if (err) return cb(err)
      info = newInfo
      cb()
    })
  }

  var parseProcedure = function (cb) {
    async.waterfall([
      waitForBitcoind,
      infoPopulate,
      getNextBlockHeight,
      getNextBlock,
      checkNextBlock,
      conditionalParseNextBlock
    ], cb !== undefined ? cb : finishParsing)
  }

  var parseNow = function (args, cb) {
    if (typeof args === 'function') {
      cb = args
      args = null
    }

    parseControl.doParse(parseProcedure);
    cb(null, true)
  }

  var getAddressesUtxos = function (args, cb) {
    var addresses = args.addresses
    var numOfConfirmations = args.numOfConfirmations || 0

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      bitcoin.cmd('getblockcount', [], function (err, count) {
        if (err) return cb(err)
        bitcoin.cmd('listunspent', [numOfConfirmations, 99999999, addresses], function (err, utxos) {
          if (err) return cb(err)
          async.each(utxos, function (utxo, cb) {
            redis.hget('utxos', utxo.txid + ':' + utxo.vout, function (err, assets) {
              if (err) return cb(err)
              utxo.assets = assets && JSON.parse(assets) || []
              if (utxo.confirmations) {
                utxo.blockheight = count - utxo.confirmations + 1
              } else {
                utxo.blockheight = -1
              }
              cb()
            })
          }, function (err) {
            if (err) return cb(err)
            cb(null, utxos)
          })
        })
      })
    }
  }

  var getUtxos = function (args, cb) {
    var reqUtxos = args.utxos
    var numOfConfirmations = args.numOfConfirmations || 0

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      bitcoin.cmd('getblockcount', [], function (err, count) {
        if (err) return cb(err)
        bitcoin.cmd('listunspent', [numOfConfirmations, 99999999], function (err, utxos) {
          if (err) return cb(err)
          utxos = utxos.filter(utxo => reqUtxos.findIndex(reqUtxo => reqUtxo.txid === utxo.txid && reqUtxo.index === utxo.vout) !== -1)
          async.each(utxos, function (utxo, cb) {
            redis.hget('utxos', utxo.txid + ':' + utxo.vout, function (err, assets) {
              if (err) return cb(err)
              utxo.assets = assets && JSON.parse(assets) || []
              if (utxo.confirmations) {
                utxo.blockheight = count - utxo.confirmations + 1
              } else {
                utxo.blockheight = -1
              }
              cb()
            })
          }, function (err) {
            if (err) return cb(err)
            cb(null, utxos)
          })
        })
      })
    }
  }

  var getTxouts = function (args, cb) {
    var txouts = _.cloneDeep(args.txouts)

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      async.each(txouts, function (txout, cb) {
        redis.hget('utxos', txout.txid + ':' + txout.vout, function (err, assets) {
          if (err) return cb(err)
          txout.assets = assets && JSON.parse(assets) || []
          cb()
        })
      }, function (err) {
        if (err) return cb(err)
        cb(null, txouts)
      })
    }
  }

  var transmit = function (args, cb) {
    var txHex = args.txHex
    bitcoin.cmd('sendrawtransaction', [txHex], function(err, res) {
      if (err) {
        return cb(err)
      }
      var transaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(txHex))

      var txsToParse = [transaction]

      var txsToCheck = [transaction]

      async.whilst(
        function() { return txsToCheck.length > 0 },
        function(callback) {
          var txids = txsToCheck.map(function(tx) { return tx.vin.map(function(vin) { return vin.txid}) })
          txids = [].concat.apply([], txids)
          txids = [...new Set(txids)]
          txsToCheck = []
          getNewMempoolTxids(txids, function(err, txids) {
            if (err) return callback(err)
            if (txids.length == 0) return callback()
            var batch = txids.map(function(txid) { return { 'method': 'getrawtransaction', 'params': [txid] } })
            bitcoin.cmd(
              batch,
              function (rawTransaction, cb) {
                var tx = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
                txsToCheck.push(tx)
                txsToParse.unshift(tx)
              },
              function(err) {
                if (err) return callback(err)
                return callback()
              }
            )
          })
        },
        function (err) {
          if (err) return cb(null, '{ "txid": "' +  res + '" }')
          parseNewMempoolTransactions(txsToParse, function(err) {
            if (err) return cb(null, '{ "txid": "' +  res + '" }')
            return cb(null, '{ "txid": "' +  res + '" }')
          })
        }
      )
    })
  }

  var addColoredInputs = function (transaction, cb) {
    async.each(transaction.vin, function (input, cb) {
      redis.hget('utxos', input.txid + ':' + input.vout, function (err, assets) {
        if (err) return cb(err)
        assets = assets && JSON.parse(assets) || []
        input.assets = assets
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      cb(null, transaction)
    })
  }

  var addColoredOutputs = function (transaction, cb) {
    async.each(transaction.vout, function (output, cb) {
      redis.hget('utxos', transaction.txid + ':' + output.n, function (err, assets) {
        if (err) return cb(err)
        assets = assets && JSON.parse(assets) || []
        output.assets = assets
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      cb(null, transaction)
    })
  }

  var addColoredIOs = function (transaction, cb) {
    async.waterfall([
      function (cb) {
        addColoredInputs(transaction, cb)
      },
      function (transaction, cb) {
        addColoredOutputs(transaction, cb)
      }
    ], cb)
  }

  var getAddressesTransactions = function (args, cb) {
    var addresses = args.addresses

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      var next = true
      var txs = {}
      var txids = []
      var skip = 0
      var count = 10
      var transactions = {}

      async.whilst(function () {
        return next
      }, function (cb) {
        bitcoin.cmd('listtransactions', [label, count, skip, true], function (err, transactions) {
          if (err) return cb(err)
          skip += count
          transactions.forEach(function (transaction) {
            if (~addresses.indexOf(transaction.address) && !~txids.indexOf(transaction.txid)) {
              txs[transaction.txid] = transaction
              txids.push(transaction.txid)
            }
          })
          if (transactions.length < count) {
            next = false
          }
          cb()
        })
      }, function (err) {
        if (err) return cb(err)
        var batch = txids.map(function (txid) {
          return {'method': 'getrawtransaction', 'params': [txid]}
        })
        bitcoin.cmd('getblockcount', [], function (err, count) {
          if (err) return cb(err)
          bitcoin.cmd(batch, function (rawTransaction, cb) {
            var transaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
            var tx = txs[transaction.txid]
            addColoredIOs(transaction, function (err) {
              transaction.confirmations = tx.confirmations
              if (transaction.confirmations) {
                transaction.blockheight = count - transaction.confirmations + 1
                transaction.blocktime = tx.blocktime * 1000
              } else {
                transaction.blockheight = -1
                transaction.blocktime = tx.timereceived * 1000
              }
              transactions[transaction.txid] = transaction
              cb()
            })
          }, function (err) {
            if (err) return cb(err)

            var prevOutputIndex = {}

            Object.values(transactions).forEach(function (tx) {
              tx.vin.forEach(function (vin) {
                prevOutputIndex[vin.txid] = prevOutputIndex[vin.txid] || []
                prevOutputIndex[vin.txid].push(vin)
              })
            })

            var prevOutsBatch = Object.keys(prevOutputIndex).map(function (txid) {
              return {'method': 'getrawtransaction', 'params': [txid]}
            })
            bitcoin.cmd(prevOutsBatch, function (rawTransaction, cb) {
              var transaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
              var txid = transaction.id
              prevOutputIndex[transaction.txid].forEach(function (vin) {
                vin.previousOutput = transaction.vout[vin.vout]
                if (vin.previousOutput.scriptPubKey && vin.previousOutput.scriptPubKey.addresses) {
                  vin.previousOutput.addresses = vin.previousOutput.scriptPubKey.addresses
                }
              })
              cb()
            }, function (err) {
              if (err) return cb(err)

              Object.values(transactions).forEach(function (tx) {
                tx.fee = tx.vin.reduce(function (sum, vin) {
                  return sum + vin.previousOutput.value
                }, 0) - tx.vout.reduce(function (sum, vout) {
                  return sum + vout.value
                }, 0)
                tx.totalsent = tx.vin.reduce(function (sum, vin) {
                  return sum + vin.previousOutput.value
                }, 0)
              })
              cb(null, Object.values(transactions))
            })
          })
        })
      })
    }
  }

  var getBitcoindInfo = function (cb) {
    var btcInfo
    async.waterfall([
      function (cb) {
        bitcoin.cmd('getinfo', [], cb)
      },
      function (_btcInfo, cb) {
        if (typeof _btcInfo === 'function') {
          cb = _btcInfo
          _btcInfo = null
        }
        if (!_btcInfo) return cb('No reply from getinfo')
        btcInfo = _btcInfo
        bitcoin.cmd('getblockhash', [btcInfo.blocks], cb)
      },
      function (lastBlockHash, cb) {
        bitcoin.cmd('getblock', [lastBlockHash], cb)
      }
    ],
    function (err, lastBlockInfo) {
      if (err) return cb(err)
      btcInfo.timestamp = lastBlockInfo.time
      btcInfo.cctimestamp = info.cctimestamp
      btcInfo.ccheight = info.ccheight
      cb(null, btcInfo)
    })
  }

  var getInfo = function (args, cb) {
    if (typeof args === 'function') {
      cb = args
      args = null
    }
    cb(null, info)
  }

  // Return: { - A dictionary where the keys are blockchain addresses
  //   <address>: {
  //     totalBalance: [Number], - Total balance amount
  //     unconfirmedBalance: [Number] - Unconfirmed balance amount
  //   }
  // }
  const getAssetHolders = function (args, cb) {
    const assetId = args.assetId;
    const numOfConfirmations = args.numOfConfirmations || 0;

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      // Get addresses associated with asset
      redis.hget('asset-addresses', assetId, function (err, strAddresses) {
        if (err) cb(err);

        if (strAddresses) {
          const addresses = JSON.parse(strAddresses);

          // Retrieve UTXOs associated with asset addresses
          bitcoin.cmd('listunspent', [numOfConfirmations, 99999999, addresses], function (err, utxos) {
            if (err) return cb(err);

            const addressBalance = {};

            async.each(utxos, function (utxo, cb) {
              // Get assets associated with UTXO
              redis.hget('utxos', utxo.txid + ':' + utxo.vout, function (err, strAssets) {
                if (err) return cb(err);

                const assets = strAssets && JSON.parse(strAssets) || [];

                assets.forEach((asset) => {
                  if (asset.assetId === assetId) {
                    // Accumulate balance amount of given asset per the address associated with the UTXO
                    const bnAssetAmount = new BigNumber(asset.amount).dividedBy(Math.pow(10, asset.divisibility));
                    let balance;

                    if (!(utxo.address in addressBalance)) {
                      balance = addressBalance[utxo.address] = {
                        totalBalance: new BigNumber(0),
                        unconfirmedBalance: new BigNumber(0)
                      };
                    }
                    else {
                      balance = addressBalance[utxo.address];
                    }

                    balance.totalBalance = balance.totalBalance.plus(bnAssetAmount);

                    if (utxo.confirmations === 0) {
                      balance.unconfirmedBalance = balance.unconfirmedBalance.plus(bnAssetAmount);
                    }
                  }
                });

                cb(null);
              })
            }, function (err) {
              if (err) return cb(err);

              // Convert accumulated asset balance amounts to number
              Object.keys(addressBalance).forEach((address) => {
                let balance = addressBalance[address];

                balance.totalBalance = balance.totalBalance.toNumber();
                balance.unconfirmedBalance = balance.unconfirmedBalance.toNumber();
              });

              cb(null, addressBalance);
            });
          });
        }
        else {
          // Asset not found. Do not return anything
          cb(null);
        }
      });
    }
  };

  // Return: {
  //   total: [Number], - Total balance amount
  //   unconfirmed: [Number] - Unconfirmed balance amount
  // }
  const getAssetBalance = function (args, cb) {
    const assetId = args.assetId;
    const filterAddresses = args.addresses;
    const numOfConfirmations = args.numOfConfirmations || 0;

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      // Get addresses associated with asset
      redis.hget('asset-addresses', assetId, function (err, strAddresses) {
        if (err) cb(err);

        if (strAddresses) {
          let addresses = JSON.parse(strAddresses);

          if (filterAddresses) {
            // Only take into account the addresses passed in the call
            addresses = addresses.filter((address) => filterAddresses.indexOf(address) !== -1);
          }

          if (addresses.length > 0) {
            // Retrieve UTXOs associated with asset addresses
            bitcoin.cmd('listunspent', [numOfConfirmations, 99999999, addresses], function (err, utxos) {
              if (err) return cb(err);

              let totalBalance = new BigNumber(0);
              let unconfirmedBalance = new BigNumber(0);

              async.each(utxos, function (utxo, cb) {
                // Get assets associated with UTXO
                redis.hget('utxos', utxo.txid + ':' + utxo.vout, function (err, strAssets) {
                  if (err) return cb(err);

                  const assets = strAssets && JSON.parse(strAssets) || [];

                  assets.forEach((asset) => {
                    if (asset.assetId === assetId) {
                      // Accumulate balance amount
                      const bnAssetAmount = new BigNumber(asset.amount).dividedBy(Math.pow(10, asset.divisibility));

                      totalBalance = totalBalance.plus(bnAssetAmount);

                      if (utxo.confirmations === 0) {
                        unconfirmedBalance = unconfirmedBalance.plus(bnAssetAmount);
                      }
                    }
                  });

                  cb(null);
                })
              }, function (err) {
                if (err) return cb(err);

                // Return balance amounts
                cb(null, {
                  total: totalBalance.toNumber(),
                  unconfirmed: unconfirmedBalance.toNumber()
                });
              });
            });
          }
          else {
            // Empty list of addresses. Return zero balance
            cb(null, {
              total: 0,
              unconfirmed: 0
            });
          }
        }
        else {
          // Asset not found. Do not return anything
          cb(null);
        }
      });
    }
  };

  // Return: { - A dictionary where the keys are the asset IDs
  //   <assetId>: {
  //     totalBalance: [Number], - Total balance amount
  //     unconfirmedBalance: [Number] - Unconfirmed balance amount
  //   }
  // }
  const getMultiAssetBalance = function (args, cb) {
    const assetIds = args.assetIds;
    const filterAddresses = args.addresses;
    const numOfConfirmations = args.numOfConfirmations || 0;

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      if (assetIds.length > 0) {
        const assetBalance = {};

        async.each(assetIds, function (assetId, cb) {
          // Get addresses associated with asset
          redis.hget('asset-addresses', assetId, function (err, strAddresses) {
            if (err) cb(err);

            if (strAddresses) {
              let addresses = JSON.parse(strAddresses);

              if (filterAddresses) {
                // Only take into account the addresses passed in the call
                addresses = addresses.filter((address) => filterAddresses.indexOf(address) !== -1);
              }

              if (addresses.length > 0) {
                // Retrieve UTXOs associated with asset addresses
                bitcoin.cmd('listunspent', [numOfConfirmations, 99999999, addresses], function (err, utxos) {
                  if (err) return cb(err);

                  let totalBalance = new BigNumber(0);
                  let unconfirmedBalance = new BigNumber(0);

                  async.each(utxos, function (utxo, cb) {
                    // Get assets associated with UTXO
                    redis.hget('utxos', utxo.txid + ':' + utxo.vout, function (err, strAssets) {
                      if (err) return cb(err);

                      const assets = strAssets && JSON.parse(strAssets) || [];

                      assets.forEach((asset) => {
                        if (asset.assetId === assetId) {
                          // Accumulate balance amount
                          const bnAssetAmount = new BigNumber(asset.amount).dividedBy(Math.pow(10, asset.divisibility));

                          totalBalance = totalBalance.plus(bnAssetAmount);

                          if (utxo.confirmations === 0) {
                            unconfirmedBalance = unconfirmedBalance.plus(bnAssetAmount);
                          }
                        }
                      });

                      cb(null);
                    })
                  }, function (err) {
                    if (err) return cb(err);

                    // Save asset balance to be returned
                    assetBalance[assetId] = {
                      total: totalBalance.toNumber(),
                      unconfirmed: unconfirmedBalance.toNumber()
                    };

                    cb(null);
                  });
                });
              }
              else {
                // Empty list of addresses. Save asset balance as zero to be returned
                assetBalance[assetId] = {
                  total: 0,
                  unconfirmed: 0
                };

                cb(null);
              }
            }
            else {
              // Asset not found. Do not do anything
              cb(null);
            }
          });
        }, function (err) {
          if (err) return cb(err);

          cb(null, assetBalance);
        });
      }
      else {
        // An empty list of asset IDs has been passed. Do not return anything
        cb(null);
      }
    }
  };

  // Return: { - A dictionary where the keys are the transaction IDs
  //   <txid>: {
  //     amount: [Number], - The amount of asset issued
  //     divisibility: [Number], - The number of decimal places used to represent the smallest amount of the asset
  //     lockStatus: [Boolean], - Indicates whether this is a locked (true) or unlocked (false) asset.
  //     aggregationPolicy: [String] - Indicates whether asset amount from different UTXOs can be summed together.
  //                                    Valid values: 'aggregatable', 'hybrid', and 'dispersed'
  //   }
  // }
  const getAssetIssuance = function (args, cb) {
    const assetId = args.assetId;

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      // Get transactions used to issue asset
      redis.hget('asset-issuance', assetId, function (err, strIssuance) {
        if (err) cb(err);

        const issuance = JSON.parse(strIssuance);

        if (issuance) {
          const retIssuance = {};

          async.eachSeries(Object.keys(issuance), function (txid, cb) {
            // Prepare issuance info for this transaction
            const txIssuance = issuance[txid];
            const issuanceInfo = {
              amount: new BigNumber(0),
              divisibility: txIssuance.divisibility,
              lockStatus: txIssuance.lockStatus,
              aggregationPolicy: txIssuance.aggregationPolicy
            };

            // Compute issued asset amount
            redis.hget('transaction-utxos', txid, function (err, strUtxos) {
              if (err) cb(err);

              const utxos = JSON.parse(strUtxos);

              async.each(utxos, function (utxo, cb) {
                redis.hget('utxos', utxo, function (err, strAssets) {
                  const assets = JSON.parse(strAssets);

                  assets.forEach((asset) => {
                    if (asset.assetId === assetId && asset.issueTxid === txid) {
                      // Accumulate issued asset amount
                      const bnAssetAmount = new BigNumber(asset.amount).dividedBy(Math.pow(10, asset.divisibility));

                      issuanceInfo.amount = issuanceInfo.amount.plus(bnAssetAmount);
                    }
                  });

                  cb(null);
                });
              }, function (err) {
                if (err) cb(err);

                // Convert accumulated asset amount to number and save issuance info
                //  for this transaction
                issuanceInfo.amount = issuanceInfo.amount.toNumber();

                retIssuance[txid] = issuanceInfo;

                cb(null)
              });
            });
          }, function (err) {
            if (err) return cb(err);

            cb(null, retIssuance);
          });
        }
        else {
          // Asset not found. Do not return anything
          cb(null);
        }
      });
    }
  };

  // Return: {
  //   address: [String] - The blockchain address used to issued amount of this asset
  // }
  const getAssetIssuingAddress = function (args, cb) {
    const assetId = args.assetId;

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      // Get transactions used to issue asset
      redis.hget('asset-issuance', assetId, function (err, strIssuance) {
        if (err) cb(err);

        const issuance = JSON.parse(strIssuance);

        if (issuance) {
          // Get ID of first issuing transaction
          const issuingTxid = Object.keys(issuance)[0];

          // Retrieve transaction info
          bitcoin.cmd('getrawtransaction', [issuingTxid, true], function (err, issuingTx) {
            if (err) cb(err);

            // Retrieve tx output associated with first input of transaction
            bitcoin.cmd('getrawtransaction', [issuingTx.vin[0].txid, true], function (err, tx) {
              if (err) cb(err);

              // Return address associated with tx output
              cb(null, {
                address: tx.vout[issuingTx.vin[0].vout].scriptPubKey.addresses[0]
              });
            })
          })
        }
        else {
          // Asset not found. Do not return anything
          cb(null);
        }
      });
    }
  };

  // Return: { - A dictionary where the keys are the asset IDs
  //   <assetId>: {
  //     totalBalance: [Number], - Total balance amount
  //     unconfirmedBalance: [Number] - Unconfirmed balance amount
  //   }
  // }
  const getOwningAssets = function (args, cb) {
    const addresses = args.addresses ;
    const numOfConfirmations = args.numOfConfirmations || 0;

    if (args.waitForParsing) {
      parseControl.doProcess(innerProcess)
    }
    else {
      innerProcess()
    }

    function innerProcess() {
      if (addresses.length > 0) {
        // Retrieve UTXOs associated with given addresses
        bitcoin.cmd('listunspent', [numOfConfirmations, 99999999, addresses], function (err, utxos) {
          if (err) return cb(err);

          const assetBalance = {};

          async.each(utxos, function (utxo, cb) {
            // Get assets associated with UTXO
            redis.hget('utxos', utxo.txid + ':' + utxo.vout, function (err, strAssets) {
              if (err) return cb(err);

              const assets = strAssets && JSON.parse(strAssets) || [];

              assets.forEach((asset) => {
                // Accumulate asset balance amount per asset associated with the UTXO
                const bnAssetAmount = new BigNumber(asset.amount).dividedBy(Math.pow(10, asset.divisibility));
                let balance;

                if (!(asset.assetId in assetBalance)) {
                  balance = assetBalance[asset.assetId] = {
                    totalBalance: new BigNumber(0),
                    unconfirmedBalance: new BigNumber(0)
                  };
                }
                else {
                  balance = assetBalance[asset.assetId];
                }

                balance.totalBalance = balance.totalBalance.plus(bnAssetAmount);

                if (utxo.confirmations === 0) {
                  balance.unconfirmedBalance = balance.unconfirmedBalance.plus(bnAssetAmount);
                }
              });

              cb(null);
            })
          }, function (err) {
            if (err) return cb(err);

            // Convert accumulated asset balance amounts to number
            Object.keys(assetBalance).forEach((asset) => {
              let balance = assetBalance[asset];

              balance.totalBalance = balance.totalBalance.toNumber();
              balance.unconfirmedBalance = balance.unconfirmedBalance.toNumber();
            });

            cb(null, assetBalance);
          });
        });
      }
      else {
        // An empty list of addresses has been passed. Do not return anything
        cb(null);
      }
    }
  };

  var injectColoredUtxos = function (method, params, ans, cb) {
    // TODO
    cb(null, ans)
  }

  var proxyBitcoinD = function (method, params, cb) {
    bitcoin.cmd(method, params, function (err, ans) {
      if (err) return cb(err)
      injectColoredUtxos(method, params, ans, cb)
    })
  }

  return {
    parse: parse,
    importAddresses: importAddresses,
    parseNow: parseNow,
    getAddressesUtxos: getAddressesUtxos,
    getUtxos: getUtxos,
    getTxouts: getTxouts,
    getAddressesTransactions: getAddressesTransactions,
    transmit: transmit,
    getInfo: getInfo,
    getAssetHolders: getAssetHolders,
    getAssetBalance: getAssetBalance,
    getMultiAssetBalance: getMultiAssetBalance,
    getAssetIssuance: getAssetIssuance,
    getAssetIssuingAddress: getAssetIssuingAddress,
    getOwningAssets: getOwningAssets,
    proxyBitcoinD: proxyBitcoinD,
    emitter: emitter
  }
}
