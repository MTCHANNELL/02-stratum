var events = require('events');
var crypto = require('crypto');

var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');

// Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) {
    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = BigInt(instanceId) << BigInt(27);

    this.next = function () {
        counter++;
        // Ensure counter is within a safe range
        if (counter > BigInt('0xFFFFFFFF')) {
            counter = BigInt(instanceId) << BigInt(27);
        }
        var extraNonce = util.packUInt32BE(Number(counter & BigInt('0xFFFFFFFF')));
        return extraNonce.toString('hex');
    };

    this.size = 4; // bytes
};

// Unique job per new block template
var JobCounter = function () {
    var counter = 0;

    this.next = function () {
        counter++;
        if (counter % 0xffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
**/
var JobManager = module.exports = function JobManager(options) {
    var _this = this;
    var jobCounter = new JobCounter();
    var emitErrorLog = function (text) { _this.emit('log', 'error', text); };

    // Initialize extranonce counter
    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
    this.extraNoncePlaceholder = Buffer.from('f000000ff111111f', 'hex');
    this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;
    this.currentJob;
    this.validJobs = {};

    // Initialize shareMultiplier, with a default value if not provided
    this.shareMultiplier = options.shareMultiplier || 1;

    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    var coinbaseHasher = (function () {
        switch (options.coin.algorithm) {
            case 'keccak':
            case 'blake':
            case 'fugue':
            case 'groestl':
                if (options.coin.normalHashing === true)
                    return util.sha256d;
                else
                    return util.sha256;
            default:
                return util.sha256d;
        }
    })();


    var blockHasher = (function () {
        switch (options.coin.algorithm) {
            case 'scrypt':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-og':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-jane':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-n':
            case 'sha1':
            case 'yespowerSUGAR':
            case 'yescryptR8G':
            case 'lyra2re2':
            case 'yespowerLTNCG':
            case 'yescryptR16':
            case 'yespowerR16':
                return function (d) {
                    return util.reverseBuffer(util.sha256d(d));
                };
            default:
                return function () {
                    return util.reverseBuffer(hashDigest.apply(this, arguments));
                };
        }
    })();

    var getKotoFoundersReward = function (rpcData, recipients) {
        if (!options.coin.kotoFoundersReward) {
            return recipients;
        }

        var founders = []
        for (var i = 0; i < options.coin.kotoFoundersReward.length; i++) {
            var founder = options.coin.kotoFoundersReward[i];
            if (rpcData.height >= founder.start && rpcData.height <= founder.last) {
                try {
                    founders.push({
                        percent: 0,
                        value: rpcData.coinbasetxn.foundersreward,
                        script: util.getKotoFounderRewardScript(founder.address)
                    });
                } catch (e) {
                    emitErrorLog('Error generating transaction output script for ' + founder.address + ' in rewardRecipients');
                }
            }
        }

        return founders.concat(recipients);
    }

    this.updateCurrentJob = function (rpcData) {

        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            getKotoFoundersReward(rpcData, options.recipients),
            options.network
        );

        _this.currentJob = tmpBlockTemplate;
        _this.emit('updatedBlock', tmpBlockTemplate, true);
        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
    };

    // returns true if processed a new block
    this.processTemplate = function (rpcData) {

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
           block height is greater than the one we have */
        var isNewBlock = typeof (_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;

            // If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;

        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            getKotoFoundersReward(rpcData, options.recipients),
            options.network
        );

        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    };

    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, versionMask) {
        var shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return { error: error, result: null };
        };
    
        var submitTime = Date.now() / 1000 | 0;
    
        if (extraNonce2.length / 2 !== _this.extraNonce2Size)
            return shareError([20, 'incorrect size of extranonce2']);
    
        var job = this.validJobs[jobId];
        if (typeof job === 'undefined' || job.jobId != jobId) {
            return shareError([21, 'job not found']);
        }
        if (nTime.length !== 8) {
            return shareError([20, 'incorrect size of ntime']);
        }
        var nTimeInt = parseInt(nTime, 16);
        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            return shareError([20, 'ntime out of range']);
        }
        if (nonce.length !== 8) {
            return shareError([20, 'incorrect size of nonce']);
        }
        if (!job.registerSubmit(extraNonce1, extraNonce2, nTime, nonce)) {
            return shareError([22, 'duplicate share']);
        }
    
        var extraNonce1Buffer = Buffer.from(extraNonce1, 'hex');
        var extraNonce2Buffer = Buffer.from(extraNonce2, 'hex');
    
        var coinbaseBuffer = job.serializeCoinbase(extraNonce1Buffer, extraNonce2Buffer);
        var coinbaseHash = coinbaseHasher(coinbaseBuffer);
    
        var merkleRoot = util.reverseBuffer(job.merkleTree.withFirst(coinbaseHash)).toString('hex');
    
        var headerBuffer = job.serializeHeader(merkleRoot, nTime, nonce, versionMask);
        var headerHash = hashDigest(headerBuffer, nTimeInt);
        var headerBigNum = BigInt('0x' + util.reverseBuffer(headerHash).toString('hex'));
    
        var blockHashInvalid;
        var blockHash;
        var blockHex;
    
        var algorithm = job.algorithm || options.coin.algorithm;
        var algoProps = algos[algorithm];
    
        if (!algoProps) {
            return shareError([24, `Algorithm properties not found for ${algorithm}`]);
        }
    
        var diff1;
        try {
            // Ensure algoProps.diff is defined; if not, set a default value
            diff1 = BigInt(algoProps.diff || '0x00000000ffff0000000000000000000000000000000000000000000000000000');
        } catch (e) {
            return shareError([25, 'Cannot convert diff to BigInt: ' + e.message]);
        }
        var multiplier = algoProps.multiplier || 1;
    
        var shareDiff = Number(diff1) / Number(headerBigNum) * multiplier;
    
        var blockDiffAdjusted = job.difficulty * multiplier;
    
        blockHexInvalid = job.serializeBlock(headerBuffer, coinbaseBuffer).toString('hex');
    
        blockHashInvalid = blockHasher(headerBuffer, nTime).toString('hex');
    
        // Check if share is a block candidate (matched network difficulty)
        if (job.target >= headerBigNum) {
            blockHex = job.serializeBlock(headerBuffer, coinbaseBuffer).toString('hex');
            blockHash = blockHasher(headerBuffer, nTime).toString('hex');
        } else {
            if (options.emitInvalidBlockHashes)
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerBuffer)).toString('hex');
    
            // Check if share didn't reach the miner's difficulty
            if (shareDiff / difficulty < 0.99) {
                // Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                } else {
                    return shareError([23, `low difficulty share of ${shareDiff}`]);
                }
            }
        }
    
        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.coinbasevalue,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid
        }, blockHex);
    
        return { result: true, error: null, blockHash: blockHash };
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;