import { EventEmitter } from 'events'
import createLogger from 'ilp-logger'
import { DataAndMoneyStream } from './stream'
import * as IlpPacket from 'ilp-packet'
import * as cryptoHelper from './crypto'
import {
  Packet,
  Frame,
  StreamMoneyFrame,
  StreamCloseFrame,
  StreamDataFrame,
  StreamMaxMoneyFrame,
  FrameType,
  IlpPacketType,
  ConnectionNewAddressFrame,
  ConnectionAssetDetailsFrame,
  ErrorCode,
  ConnectionCloseFrame,
  ConnectionStreamIdBlockedFrame,
  ConnectionMaxStreamIdFrame,
  StreamMaxDataFrame,
  StreamDataBlockedFrame,
  ConnectionMaxDataFrame,
  ConnectionDataBlockedFrame,
  StreamMoneyBlockedFrame
} from './packet'
import { Reader } from 'oer-utils'
import { Plugin } from './util/plugin-interface'
import BigNumber from 'bignumber.js'
require('source-map-support').install()

const RETRY_DELAY_START = 100
const RETRY_DELAY_MAX = 43200000 // 12 hours should be long enough
const RETRY_DELAY_INCREASE_FACTOR = 1.5
const DEFAULT_PACKET_TIMEOUT = 30000
const DEFAULT_IDLE_TIMEOUT = 60000 // 1 minute
const MAX_DATA_SIZE = 32767
const DEFAULT_MAX_REMOTE_STREAMS = 10
const DEFAULT_MINIMUM_EXCHANGE_RATE_PRECISION = 3

export interface ConnectionOpts {
  /** Ledger plugin (V2) */
  plugin: Plugin,
  /** ILP Address of the remote entity */
  destinationAccount?: string,
  /** ILP Address of the plugin */
  sourceAccount?: string,
  /** Specifies how much worse than the initial test packet that the exchange rate is allowed to get before packets are rejected */
  slippage?: BigNumber.Value,
  /** Pad packets to the maximum size (data field of 32767 bytes). False by default */
  enablePadding?: boolean,
  /** User-specified connection identifier that was passed into [`generateAddressAndSecret`]{@link Server#generateAddressAndSecret} */
  connectionTag?: string,
  /** Maximum number of streams the other entity can have open at once. Defaults to 10 */
  maxRemoteStreams?: number,
  /** Number of bytes each connection can have in the buffer. Defaults to 65534 */
  connectionBufferSize?: number
  /** Minimum Precision to use when determining the exchange rate */
  minExchangeRatePrecision?: number
  /** Inactivity timeout (milliseconds) */
  idleTimeout?: number
}

export interface FullConnectionOpts extends ConnectionOpts {
  sourceAccount: string,
  assetCode: string,
  assetScale: number,
  isServer: boolean,
  /** Shared secret generawait new Promise((resolve, reject) => setTimeout(resolve, retryDelay))ated by the server with [`generateAddressAndSecret`]{@link Server#generateAddressAndSecret} */
  sharedSecret: Buffer
}

export class ConnectionError extends Error {
  streamErrorCode: ErrorCode

  constructor (message: string, streamErrorCode?: ErrorCode) {
    super(message)
    this.streamErrorCode = streamErrorCode || ErrorCode.InternalError
  }
}

/**
 * Class representing the connection between a [`Client`]{@link createConnection} and a [`Server`]{@link Server}.
 * A single connection can be used to send or receive on [Streams]{@link DataAndMoneyStream}.
 *
 * Streams are created using the [`createStream`]{@link createStream} method.
 * The `'stream'` event will be emitted whenever a new incoming stream is opened by the other party.
 */
export class Connection extends EventEmitter {
  /** Application identifier for a certain connection */
  readonly connectionTag?: string

  protected plugin: Plugin
  protected _sourceAccount: string
  protected _sourceAssetCode: string
  protected _sourceAssetScale: number
  protected _destinationAccount?: string
  protected _destinationAssetCode?: string
  protected _destinationAssetScale?: number
  protected sharedSecret: Buffer
  protected isServer: boolean
  protected slippage: BigNumber
  protected allowableReceiveExtra: BigNumber
  protected enablePadding: boolean
  protected maxBufferedData: number

  protected idleTimeout: number
  protected lastActive: Date
  protected idleTimer: NodeJS.Timer

  protected nextPacketSequence: number
  protected streams: Map<number, DataAndMoneyStream>
  protected closedStreams: { [id: number]: boolean }
  protected nextStreamId: number
  protected maxStreamId: number
  protected log: any
  protected sending: boolean
  /** Used to probe for the Maximum Packet Amount if the connectors don't tell us directly */
  protected testMaximumPacketAmount: BigNumber
  /** The path's Maximum Packet Amount, discovered through F08 errors */
  protected maximumPacketAmount: BigNumber
  protected minExchangeRatePrecision: number
  protected closed: boolean
  protected exchangeRate?: BigNumber
  protected retryDelay: number
  protected queuedFrames: Frame[]

  protected remoteClosed: boolean
  protected remoteMaxStreamId: number
  protected remoteKnowsOurAccount: boolean

  // TODO use bignumbers for byte offsets
  protected remoteMaxOffset: number
  protected _totalReceived: BigNumber
  protected _totalSent: BigNumber
  protected _totalDelivered: BigNumber
  protected _lastPacketExchangeRate: BigNumber

  constructor (opts: FullConnectionOpts) {
    super()
    this.plugin = opts.plugin
    this._sourceAccount = opts.sourceAccount
    this._sourceAssetCode = opts.assetCode
    this._sourceAssetScale = opts.assetScale
    this._destinationAccount = opts.destinationAccount
    this.sharedSecret = opts.sharedSecret
    this.isServer = opts.isServer
    this.slippage = new BigNumber(opts.slippage || 0)
    this.allowableReceiveExtra = new BigNumber(1.01)
    this.enablePadding = !!opts.enablePadding
    this.connectionTag = opts.connectionTag
    this.maxStreamId = 2 * (opts.maxRemoteStreams || DEFAULT_MAX_REMOTE_STREAMS)
    this.maxBufferedData = opts.connectionBufferSize || MAX_DATA_SIZE * 2
    this.minExchangeRatePrecision = opts.minExchangeRatePrecision || DEFAULT_MINIMUM_EXCHANGE_RATE_PRECISION
    this.idleTimeout = opts.idleTimeout || DEFAULT_IDLE_TIMEOUT
    this.lastActive = new Date()

    this.nextPacketSequence = 1
    // TODO should streams be a Map or just an object?
    this.streams = new Map()
    this.closedStreams = {}
    this.nextStreamId = (this.isServer ? 2 : 1)
    this.log = createLogger(`ilp-protocol-stream:${this.isServer ? 'Server' : 'Client'}:Connection`)
    this.sending = false
    this.closed = true
    this.queuedFrames = []

    this.maximumPacketAmount = new BigNumber(Infinity)
    this.testMaximumPacketAmount = new BigNumber(Infinity)
    this.retryDelay = RETRY_DELAY_START

    this.remoteClosed = false
    this.remoteKnowsOurAccount = this.isServer
    this.remoteMaxStreamId = DEFAULT_MAX_REMOTE_STREAMS * 2

    this.remoteMaxOffset = this.maxBufferedData

    this._totalReceived = new BigNumber(0)
    this._totalSent = new BigNumber(0)
    this._totalDelivered = new BigNumber(0)
    this._lastPacketExchangeRate = new BigNumber(0)
  }

  /**
   * New incoming stream event
   * @event stream
   * @type {DataAndMoneyStream}
   */

  /**
   * Start sending or receiving.
   * @fires stream
   */
  async connect (): Promise<void> {
    if (!this.closed) {
      return Promise.resolve()
    }
    /* tslint:disable-next-line:no-floating-promises */
    this.startSendLoop()
    await new Promise((resolve, reject) => {
      const connectHandler = () => {
        cleanup()
        resolve()
      }
      const closeHandler = () => {
        cleanup()
        reject(new Error('Connection was closed before it was connected'))
      }
      const errorHandler = (error?: Error) => {
        cleanup()
        reject(new Error(`Error connecting${error ? ': ' + error.message : ''}`))
      }
      this.once('connect', connectHandler)
      this.once('error', errorHandler)
      this.once('close', closeHandler)
      this.once('end', closeHandler)

      const self = this
      function cleanup () {
        clearTimeout(self.idleTimer)
        self.removeListener('connect', connectHandler)
        self.removeListener('error', errorHandler)
        self.removeListener('close', closeHandler)
        self.removeListener('end', closeHandler)
      }
    })
    this.closed = false
    this.startIdleTimer()
  }

  /**
   * Close the connection when all streams have finished sending their money and data
   */
  // TODO should this be sync or async?
  async end (): Promise<void> {
    this.log.info('closing connection')
    // Create Promises on each stream that resolve on the 'end' event so
    // we can wait for them all to be completed before closing the connection
    let streamEndPromises: Promise<any>[] = []
    for (let [_, stream] of this.streams) {
      if (stream.isOpen()) {
        streamEndPromises.push(new Promise((resolve, reject) => {
          stream.on('end', resolve)
        }))
        stream.end()
      }
    }

    await new Promise((resolve, reject) => {
      this.once('_send_loop_finished', resolve)
      this.once('error', reject)

      /* tslint:disable-next-line:no-floating-promises */
      this.startSendLoop()
    })
    // Wait for the send loop to finish & all the streams to end
    // before marking the connection as closed so the streams
    // can finish sending data or money.
    await Promise.all(streamEndPromises)

    this.closed = true
    await this.sendConnectionClose()
    this.safeEmit('end')
    this.safeEmit('close')
  }

  /**
   * Immediately close the connection and all streams
   */
  // TODO should this be sync or async?
  async destroy (err?: Error): Promise<void> {
    this.log.error('destroying connection with error:', err)
    if (err) {
      this.safeEmit('error', err)
    }
    // Create Promises on each stream that resolve on the 'close' event so
    // we can wait for them all to be completed before closing the connection
    let streamClosePromises: Promise<any>[] = []
    for (let [_, stream] of this.streams) {
      streamClosePromises.push(new Promise((resolve, reject) => {
        stream.on('close', resolve)
      }))
      // TODO should we pass the error to each stream?
      stream.destroy()
    }
    await this.sendConnectionClose(err)
    // wait for all the streams to be closed before emitting the connection 'close'
    await Promise.all(streamClosePromises)
    this.safeEmit('close')
  }

  /**
   * Returns a new bidirectional [`DataAndMoneyStream`]{@link DataAndMoneyStream}
   */
  createStream (): DataAndMoneyStream {
    // Make sure we don't open more streams than the remote will allow
    if (this.remoteMaxStreamId < this.nextStreamId) {
      this.log.debug(`cannot create another stream. nextStreamId: ${this.nextStreamId}, remote maxStreamId: ${this.remoteMaxStreamId}`)
      this.queuedFrames.push(new ConnectionStreamIdBlockedFrame(this.nextStreamId))
      throw new Error(`Creating another stream would exceed the remote connection's maximum number of open streams`)
    }

    // TODO should this inform the other side?
    const stream = new DataAndMoneyStream({
      id: this.nextStreamId,
      isServer: this.isServer
    })
    this.streams.set(this.nextStreamId, stream)
    this.log.debug(`created stream: ${this.nextStreamId}`)
    this.nextStreamId += 2

    stream.on('_maybe_start_send_loop', this.startSendLoop.bind(this))
    stream.once('close', () => this.removeStreamRecord(stream))

    return stream
  }

  /**
   * ILP Address of the remote party to this connection.
   */
  get destinationAccount (): string | undefined {
    return this._destinationAccount
  }

  /**
   * Scale of the asset used by the remote party to this connection
   */
  get destinationAssetScale (): number | undefined {
    return this._destinationAssetScale
  }

  /**
   * Code of the asset used by the remote party to this connection
   */
  get destinationAssetCode (): string | undefined {
    return this._destinationAssetCode
  }

  /**
   * ILP Address of the plugin passed to this connection.
   */
  get sourceAccount (): string {
    return this._sourceAccount
  }

  /**
   * Scale of the asset used by the plugin passed to this connection
   */
  get sourceAssetScale (): number {
    return this._sourceAssetScale
  }

  /**
   * Code of the asset used by the plugin passed to this connection
   */
  get sourceAssetCode (): string {
    return this._sourceAssetCode
  }

  /**
   * Connections minimum exchange rate with slippage included, if not set '0' is returned.
   */
  get minimumAcceptableExchangeRate (): string {
    if (this.exchangeRate) {
      const minimumExchangeWithSlippage = this.exchangeRate
         .times(new BigNumber(1).minus(this.slippage))
      return minimumExchangeWithSlippage.toString()
    }
    return '0'
  }

 /**
  * Calculates the last exchange rate based on last packet successfully sent.
  */
  get lastPacketExchangeRate (): string {
    return this._lastPacketExchangeRate.toString()
  }

  /**
   * Total delivered so far, denominated in the connection plugin's units.
   */
  get totalDelivered (): string {
    return this._totalDelivered.toString()
  }

  /**
   * Total sent so far, denominated in the connection plugin's units.
   */
  get totalSent (): string {
    return this._totalSent.toString()
  }

  /**
   * Total received so far by the local side, denominated in the connection plugin's units.
   */
  get totalReceived (): string {
    return this._totalReceived.toString()
  }

  /**
   * (Internal) Handle incoming ILP Prepare packets.
   * This will automatically fulfill all valid and expected Prepare packets.
   * It passes the incoming money and/or data to the relevant streams.
   * @private
   */
  async handlePrepare (prepare: IlpPacket.IlpPrepare): Promise<IlpPacket.IlpFulfill> {
    // Parse packet
    let requestPacket: Packet
    try {
      requestPacket = Packet.decryptAndDeserialize(this.sharedSecret, prepare.data)
    } catch (err) {
      this.log.error(`error parsing frames:`, err)
      throw new IlpPacket.Errors.UnexpectedPaymentError('')
    }
    this.log.trace('handling packet:', JSON.stringify(requestPacket))

    if (requestPacket.ilpPacketType.valueOf() !== IlpPacket.Type.TYPE_ILP_PREPARE) {
      this.log.error(`prepare packet contains a frame that says it should be something other than a prepare: ${requestPacket.ilpPacketType}`)
      throw new IlpPacket.Errors.UnexpectedPaymentError('')
    }
    this.bumpIdle()

    let responseFrames: Frame[] = []

    // Tell peer how much data connection can receive
    responseFrames.push(new ConnectionMaxDataFrame(this.getIncomingOffsets().maxAcceptable))

    const throwFinalApplicationError = () => {
      responseFrames = responseFrames.concat(this.queuedFrames)
      this.queuedFrames = []
      const responsePacket = new Packet(requestPacket.sequence, IlpPacketType.Reject, prepare.amount, responseFrames)
      this.log.trace(`rejecting packet ${requestPacket.sequence}: ${JSON.stringify(responsePacket)}`)
      throw new IlpPacket.Errors.FinalApplicationError('', responsePacket.serializeAndEncrypt(this.sharedSecret, (this.enablePadding ? MAX_DATA_SIZE : undefined)))
    }

    // Handle new streams
    for (let frame of requestPacket.frames) {
      if (frame.type === FrameType.StreamMoney
        || frame.type === FrameType.StreamData
        // TODO should frames that set the max values open the stream?
        || frame.type === FrameType.StreamMaxMoney
        || frame.type === FrameType.StreamMaxData) {
        const streamId = frame.streamId.toNumber()

        // Check if the stream was already closed
        if (this.closedStreams[streamId]) {
          this.log.trace(`got packet with frame for stream ${streamId}, which was already closed`)

          // Don't bother sending an error frame back unless they've actually sent money or data
          if (frame.type !== FrameType.StreamMoney && frame.type !== FrameType.StreamData) {
            continue
          }

          // Respond with a StreamClose frame (unless there is already one queued)
          const framesToSend = responseFrames.concat(this.queuedFrames)
          const includesStreamClose = framesToSend.find((frame) => frame.type === FrameType.StreamClose && frame.streamId.isEqualTo(streamId))
          if (!includesStreamClose) {
            responseFrames.push(new StreamCloseFrame(streamId, ErrorCode.StreamStateError, 'Stream is already closed'))
          }
          throwFinalApplicationError()
        }

        try {
          // Note this will throw if the stream was already closed
          this.handleNewStream(frame.streamId.toNumber())
        } catch (err) {
          this.log.debug(`error handling new stream ${frame.streamId}:`, err && err.message)
          throwFinalApplicationError()
        }
      }
    }

    // TODO don't throw errors in expected cases -- they are slower than just returning a value
    try {
      this.handleControlFrames(requestPacket.frames)
    } catch (err) {
      this.log.debug('error handling frames:', err && err.message)
      throwFinalApplicationError()
    }

    // TODO keep a running total of the offsets so we don't need to recalculate each time
    const incomingOffsets = this.getIncomingOffsets()
    if (incomingOffsets.max > incomingOffsets.maxAcceptable) {
      /* tslint:disable-next-line:no-floating-promises */
      this.destroy(new ConnectionError(`Exceeded flow control limits. Max connection byte offset: ${incomingOffsets.maxAcceptable}, received: ${incomingOffsets.max}`, ErrorCode.FlowControlError))
      throwFinalApplicationError()
    }

    if (requestPacket.prepareAmount.isGreaterThan(prepare.amount)) {
      this.log.debug(`received less than minimum destination amount. actual: ${prepare.amount}, expected: ${requestPacket.prepareAmount}`)
      throwFinalApplicationError()
    }

    // Ensure we can generate correct fulfillment
    const fulfillment = cryptoHelper.generateFulfillment(this.sharedSecret, prepare.data)
    const generatedCondition = cryptoHelper.hash(fulfillment)
    if (!generatedCondition.equals(prepare.executionCondition)) {
      this.log.debug(`got unfulfillable prepare for amount: ${prepare.amount}. generated condition: ${generatedCondition.toString('hex')}, prepare condition: ${prepare.executionCondition.toString('hex')}`)
      throwFinalApplicationError()
    }

    // Determine amount to receive on each frame
    const amountsToReceive: { stream: DataAndMoneyStream, amount: BigNumber }[] = []
    const totalMoneyShares = requestPacket.frames.reduce((sum: BigNumber, frame: Frame) => {
      if (frame instanceof StreamMoneyFrame) {
        return sum.plus(frame.shares)
      }
      return sum
    }, new BigNumber(0))
    for (let frame of requestPacket.frames) {
      if (!(frame instanceof StreamMoneyFrame)) {
        continue
      }
      const streamId = frame.streamId.toNumber()
      const streamAmount = new BigNumber(prepare.amount)
        .times(frame.shares)
        .dividedBy(totalMoneyShares)
        // TODO make sure we don't lose any because of rounding issues
        .integerValue(BigNumber.ROUND_FLOOR)
      const stream = this.streams.get(streamId)!
      amountsToReceive.push({
        stream,
        amount: streamAmount
      })

      // Ensure that this amount isn't more than the stream can receive
      const maxStreamCanReceive = stream._getAmountStreamCanReceive()
        .times(this.allowableReceiveExtra)
        .integerValue(BigNumber.ROUND_CEIL)
      if (maxStreamCanReceive.isLessThan(streamAmount)) {
        // TODO should this be distributed to other streams if it can be?
        this.log.debug(`peer sent too much for stream: ${streamId}. got: ${streamAmount}, max receivable: ${maxStreamCanReceive}`)
        // Tell peer how much the streams they sent for can receive
        responseFrames.push(new StreamMaxMoneyFrame(streamId, stream.receiveMax, stream.totalReceived))

        // TODO include error frame
        throwFinalApplicationError()
      }

      // Reject the packet if any of the streams is already closed
      if (!stream.isOpen()) {
        this.log.debug(`peer sent money for stream that was already closed: ${streamId}`)
        responseFrames.push(new StreamCloseFrame(streamId, ErrorCode.StreamStateError, 'Stream is already closed'))

        throwFinalApplicationError()
      }
    }

    // Add incoming amounts to each stream
    for (let { stream, amount } of amountsToReceive) {
      stream._addToIncoming(amount)
    }

    // Tell peer about closed streams and how much each stream can receive
    if (!this.closed && !this.remoteClosed) {
      for (let [_, stream] of this.streams) {
        const streamIsClosed = !stream.isOpen() && stream._getAmountAvailableToSend().isEqualTo(0)
        if (streamIsClosed && !stream._remoteClosed) {
          this.log.trace(`telling other side that stream ${stream.id} is closed`)
          if (stream._errorMessage) {
            responseFrames.push(new StreamCloseFrame(stream.id, ErrorCode.ApplicationError, stream._errorMessage))
          } else {
            responseFrames.push(new StreamCloseFrame(stream.id, ErrorCode.NoError, ''))
          }
          // TODO confirm that they get this
          stream._remoteClosed = true
        } else {
          this.log.trace(`telling other side that stream ${stream.id} can receive ${stream.receiveMax}`)
          responseFrames.push(new StreamMaxMoneyFrame(stream.id, stream.receiveMax, stream.totalReceived))

          // TODO only send these frames when we need to
          responseFrames.push(new StreamMaxDataFrame(stream.id, stream._getIncomingOffsets().maxAcceptable))
        }
      }
    }

    // TODO make sure the queued frames aren't too big
    responseFrames = responseFrames.concat(this.queuedFrames)
    this.queuedFrames = []

    // Return fulfillment and response packet
    const responsePacket = new Packet(requestPacket.sequence, IlpPacketType.Fulfill, prepare.amount, responseFrames)
    this._totalReceived = this._totalReceived.plus(prepare.amount)
    this.log.trace(`fulfilling prepare with fulfillment: ${fulfillment.toString('hex')} and response packet: ${JSON.stringify(responsePacket)}`)
    return {
      fulfillment,
      data: responsePacket.serializeAndEncrypt(this.sharedSecret, (this.enablePadding ? MAX_DATA_SIZE : undefined))
    }
  }

  /**
   * Parse the frames from the incoming packet and apply all effects
   * except for passing money to the streams
   */
  protected handleControlFrames (frames: Frame[]): void {
    for (let frame of frames) {
      let stream
      switch (frame.type) {
        case FrameType.ConnectionNewAddress:
          this.log.trace(`peer notified us of their account: ${frame.sourceAccount}`)
          const firstConnection = this._destinationAccount === undefined
          this._destinationAccount = frame.sourceAccount
          if (firstConnection) {
            this.handleConnect()
          }
          // TODO reset the exchange rate and send a test packet to make sure they haven't spoofed the address
          break
        case FrameType.ConnectionAssetDetails:
          this.log.trace(`peer notified us of their asset details: code=${frame.sourceAssetCode}, scale=${frame.sourceAssetScale}`)
          this._destinationAssetCode = frame.sourceAssetCode
          this._destinationAssetScale = frame.sourceAssetScale
          break
        case FrameType.ConnectionClose:
          // TODO end the connection in some other way
          this.sending = false
          this.closed = true
          this.remoteClosed = true
          if (frame.errorCode === ErrorCode.NoError) {
            this.log.info(`remote closed connection`)
            /* tslint:disable-next-line:no-floating-promises */
            this.end()
          } else {
            this.log.error(`remote connection error. code: ${ErrorCode[frame.errorCode]}, message: ${frame.errorMessage}`)
            /* tslint:disable-next-line:no-floating-promises */
            this.destroy(new Error(`Remote connection error. Code: ${ErrorCode[frame.errorCode]}, message: ${frame.errorMessage}`))
          }
          break
        case FrameType.ConnectionMaxData:
          const outgoingOffsets = this.getOutgoingOffsets()
          this.log.trace(`remote connection max byte offset is: ${frame.maxOffset}, we've sent: ${outgoingOffsets.currentOffset}, we want to send up to: ${outgoingOffsets.maxOffset}`)
          if (frame.maxOffset.isGreaterThan(MAX_DATA_SIZE * 2)) {
            this.remoteMaxOffset = Math.max(frame.maxOffset.toNumber(), this.remoteMaxOffset)
          } else {
            // We assumed their size was 64kb but it turned out to be less
            this.remoteMaxOffset = frame.maxOffset.toNumber()
          }
          break
        case FrameType.ConnectionDataBlocked:
          this.log.trace(`remote wants to send more data but we are blocking them. current max incoming offset: ${this.getIncomingOffsets()}, remote max offset: ${frame.maxOffset}`)
          break
        case FrameType.ConnectionMaxStreamId:
          // TODO make sure the number isn't lowered
          this.log.trace(`remote set max stream id to ${frame.maxStreamId}`)
          this.remoteMaxStreamId = frame.maxStreamId.toNumber()
          break
        case FrameType.ConnectionStreamIdBlocked:
          this.log.trace(`remote wants to open more streams but we are blocking them`)
          break
        case FrameType.StreamClose:
          this.handleStreamClose(frame)
          break
        case FrameType.StreamMaxMoney:
          this.log.trace(`peer told us that stream ${frame.streamId} can receive up to: ${frame.receiveMax} and has received: ${frame.totalReceived} so far`)
          stream = this.streams.get(frame.streamId.toNumber())
          if (!stream) {
            break
          }
          stream._remoteReceived = BigNumber.maximum(stream._remoteReceived, frame.totalReceived)
          if (stream._remoteReceiveMax.isFinite()) {
            stream._remoteReceiveMax = BigNumber.maximum(stream._remoteReceiveMax, frame.receiveMax)
          } else {
            stream._remoteReceiveMax = frame.receiveMax
          }
          if (stream._remoteReceiveMax.isGreaterThan(stream._remoteReceived)
            && stream._getAmountAvailableToSend().isGreaterThan(0)) {
            /* tslint:disable-next-line:no-floating-promises */
            this.startSendLoop()
          }
          break
        case FrameType.StreamMoneyBlocked:
          this.log.debug(`peer told us that they want to send more money on stream ${frame.streamId} but we are blocking them. they have sent: ${frame.totalSent} so far and want to send: ${frame.sendMax}`)
          break
        case FrameType.StreamData:
          this.log.trace(`got data for stream ${frame.streamId}`)

          stream = this.streams.get(frame.streamId.toNumber())
          if (!stream) {
            break
          }
          stream._pushIncomingData(frame.data, frame.offset.toNumber())

          // Make sure the peer hasn't exceeded the flow control limits
          const incomingOffsets = stream._getIncomingOffsets()
          if (incomingOffsets.max > incomingOffsets.maxAcceptable) {
            /* tslint:disable-next-line:no-floating-promises */
            this.destroy(new ConnectionError(`Exceeded flow control limits. Stream ${stream.id} can accept up to offset: ${incomingOffsets.maxAcceptable} but got bytes up to offset: ${incomingOffsets.max}`))
          }
          break
        case FrameType.StreamMaxData:
          stream = this.streams.get(frame.streamId.toNumber())
          if (!stream) {
            break
          }
          this.log.trace(`peer told us that stream ${frame.streamId} can receive up to byte offset: ${frame.maxOffset} (we've sent up to offset: ${stream._getOutgoingOffsets().current})`)
          const oldOffset = stream._remoteMaxOffset
          stream._remoteMaxOffset = frame.maxOffset.toNumber()
          if (stream._remoteMaxOffset > oldOffset) {
            /* tslint:disable-next-line:no-floating-promises */
            this.startSendLoop()
          }
          break
        case FrameType.StreamDataBlocked:
          stream = this.streams.get(frame.streamId.toNumber())
          if (!stream) {
            break
          }
          this.log.debug(`peer told us that stream ${frame.streamId} is blocked. they want to send up to offset: ${frame.maxOffset}, but we are only allowing up to: ${stream._getIncomingOffsets().maxAcceptable}`)
          break
        default:
          continue
      }
    }
  }

  /**
   * Handle the initial connection from the other side
   */
  protected handleConnect () {
    this.closed = false
    this.log.info('connected')
    this.safeEmit('connect')

    // Tell the other side our max stream id and asset details
    this.queuedFrames.push(
      new ConnectionMaxStreamIdFrame(this.maxStreamId),
      new ConnectionAssetDetailsFrame(this.sourceAssetCode, this.sourceAssetScale)
    )
  }

  /**
   * Ensure that the new stream is valid and does not exceed our limits
   * and if it looks good, emit the 'stream' event
   */
  protected handleNewStream (streamId: number): void {
    if (this.streams.has(streamId) || this.closedStreams[streamId]) {
      return
    }

    // Validate stream ID
    if (this.isServer && streamId % 2 === 0) {
      this.log.error(`got invalid stream ID ${streamId} from peer (should be odd)`)
      this.queuedFrames.push(new ConnectionCloseFrame(ErrorCode.ProtocolViolation, `Invalid Stream ID: ${streamId}. Client-initiated streams must have odd-numbered IDs`))
      // TODO this should probably call this.destroy
      const err = new Error(`Invalid Stream ID: ${streamId}. Client-initiated streams must have odd-numbered IDs`)
      this.safeEmit('error', err)
      throw err
    } else if (!this.isServer && streamId % 2 === 1) {
      this.log.error(`got invalid stream ID ${streamId} from peer (should be even)`)
      this.queuedFrames.push(new ConnectionCloseFrame(ErrorCode.ProtocolViolation, `Invalid Stream ID: ${streamId}. Server-initiated streams must have even-numbered IDs`))
      const err = new Error(`Invalid Stream ID: ${streamId}. Server-initiated streams must have even-numbered IDs`)
      this.safeEmit('error', err)
      throw err
    }

    // Make sure there aren't too many open streams
    if (streamId > this.maxStreamId) {
      this.log.debug(`peer opened too many streams. got stream: ${streamId}, but max stream id is: ${this.maxStreamId}. closing connection`)
      this.queuedFrames.push(new ConnectionCloseFrame(ErrorCode.StreamIdError, `Maximum number of open streams exceeded. Got stream: ${streamId}, current max stream ID: ${this.maxStreamId}`))
      const err = new Error(`Maximum number of open streams exceeded. Got stream: ${streamId}, current max stream ID: ${this.maxStreamId}`)
      this.safeEmit('error', err)
      throw err
    }

    // Let the other side know if they're getting close to the number of streams
    if (this.maxStreamId * .75 < streamId) {
      this.log.trace(`informing peer that our max stream id is: ${this.maxStreamId}`)
      this.queuedFrames.push(new ConnectionMaxStreamIdFrame(this.maxStreamId))
    }

    this.log.info(`got new stream: ${streamId}`)
    const stream = new DataAndMoneyStream({
      id: streamId,
      isServer: this.isServer
    })
    this.streams.set(streamId, stream)

    stream.on('_maybe_start_send_loop', () => this.startSendLoop())
    stream.once('close', () => this.removeStreamRecord(stream))

    this.safeEmit('stream', stream)
  }

  /**
   * Mark the stream as closed
   */
  protected handleStreamClose (frame: StreamCloseFrame) {
    const streamId = frame.streamId.toNumber()
    const stream = this.streams.get(streamId)
    if (!stream) {
      this.log.error(`remote error on stream ${streamId}, but we don't have a record of that stream`)
      return
    }

    if (!stream.isOpen() || stream._remoteSentEnd) {
      return
    }

    this.log.error(`peer closed stream ${stream.id} with error code: ${ErrorCode[frame.errorCode]} and message: ${frame.errorMessage}`)
    // TODO should we confirm with the other side that we closed it?
    stream._sentEnd = true
    let err
    if (frame.errorMessage) {
      err = new Error(frame.errorMessage)
      err.name = ErrorCode[frame.errorCode]
    }
    stream._remoteEnded(err)

    // TODO make sure we don't send more than one of these frames per packet
    this.maxStreamId += 2
    this.log.trace(`raising maxStreamId to ${this.maxStreamId}`)
    this.queuedFrames.push(new ConnectionMaxStreamIdFrame(this.maxStreamId))
    // Start send loop to make sure this frame is sent
    /* tslint:disable-next-line:no-floating-promises */
    this.startSendLoop()
  }

  /**
   * (Internal) Start sending packets with money and/or data, as necessary.
   * @private
   */
  protected async startSendLoop () {
    if (this.sending) {
      return
    }
    if (this.remoteClosed) {
      this.log.debug('remote connection is already closed, not starting another loop')
      this.safeEmit('_send_loop_finished')
      return
    }
    if (!this._destinationAccount) {
      this.log.debug('not sending because we do not know the client\'s address')
      this.sending = false
      return
    }

    this.sending = true
    this.log.debug('starting send loop')

    try {
      while (this.sending) {
        // Send a test packet first to determine the exchange rate
        if (!this.exchangeRate) {
          this.log.trace('determining exchange rate')
          await this.determineExchangeRate()

          if (this.exchangeRate) {
            this.safeEmit('connect')
            this.log.trace('connected')
          } else {
            this.log.error('unable to determine exchange rate')
          }
        } else {
          // TODO Send multiple packets at the same time (don't await promise)
          // TODO Figure out if we need to wait before sending the next one
          await this.loadAndSendPacket()
        }
      }
    } catch (err) {
      // TODO should a connection error be an error on all of the streams?
      return this.destroy(err)
    }
    this.log.debug('finished sending')
    this.safeEmit('_send_loop_finished')
    for (let [_, stream] of this.streams) {
      stream.emit('_send_loop_finished')
    }
  }

  /**
   * Load up a packet money and/or data, send it to the other party, and handle the result.
   * @private
   */
  protected async loadAndSendPacket (): Promise<void> {
    // Actually send on the next tick of the event loop in case multiple streams
    // have their limits raised at the same time
    await new Promise((resolve, reject) => setImmediate(resolve))

    this.log.trace('loadAndSendPacket')
    let amountToSend = new BigNumber(0)

    // Set packet number to correlate response with request
    const requestPacket = new Packet(this.nextPacketSequence++, IlpPacketType.Prepare)

    // TODO make sure these aren't too big
    requestPacket.frames = this.queuedFrames
    this.queuedFrames = []

    // Send control frames
    // TODO only send the max amount when it changes
    for (let [_, stream] of this.streams) {
      if (stream.isOpen()) {
        requestPacket.frames.push(new StreamMaxMoneyFrame(stream.id, stream.receiveMax, stream.totalReceived))
        requestPacket.frames.push(new StreamMaxDataFrame(stream.id, stream._getIncomingOffsets().maxAcceptable))
      }
    }
    if (this.closed && !this.remoteClosed) {
      // TODO how do we know if there was an error?
      this.log.trace('sending connection close frame')
      requestPacket.frames.push(new ConnectionCloseFrame(ErrorCode.NoError, ''))
      // TODO don't put any more frames because the connection is closed
      // TODO only mark this as closed once we confirm that with the receiver
      this.remoteClosed = true
    }

    // Determine how much to send based on amount frames and path maximum packet amount
    let maxAmountFromNextStream = this.testMaximumPacketAmount
    const streamsSentFrom = []
    for (let [_, stream] of this.streams) {
      if (stream._sentEnd) {
        // TODO just remove closed streams?
        continue
      }
      // Determine how much to send from this stream based on how much it has available
      // and how much the receiver side of this stream can receive
      let amountToSendFromStream = BigNumber.minimum(stream._getAmountAvailableToSend(), maxAmountFromNextStream)
      if (this.exchangeRate) {
        const maxDestinationAmount = stream._remoteReceiveMax.minus(stream._remoteReceived)
        const maxSourceAmount = maxDestinationAmount.dividedBy(this.exchangeRate).integerValue(BigNumber.ROUND_CEIL)
        if (maxSourceAmount.isLessThan(amountToSendFromStream)) {
          this.log.trace(`stream ${stream.id} could send ${amountToSendFromStream} but that would be more than the receiver says they can receive, so we'll send ${maxSourceAmount} instead`)
          amountToSendFromStream = maxSourceAmount
        }
      }
      this.log.trace(`amount to send from stream ${stream.id}: ${amountToSendFromStream}, exchange rate: ${this.exchangeRate}, remote total received: ${stream._remoteReceived}, remote receive max: ${stream._remoteReceiveMax}`)

      // Hold the money and add a frame to the packet
      if (amountToSendFromStream.isGreaterThan(0)) {
        stream._holdOutgoing(requestPacket.sequence.toString(), amountToSendFromStream)
        // TODO make sure the length of the frames doesn't exceed packet data limit
        requestPacket.frames.push(new StreamMoneyFrame(stream.id, amountToSendFromStream))
        amountToSend = amountToSend.plus(amountToSendFromStream)
        maxAmountFromNextStream = maxAmountFromNextStream.minus(amountToSendFromStream)
        streamsSentFrom.push(stream)
      }

      // Tell peer if they're blocking us from sending money
      const amountLeftStreamWantsToSend = new BigNumber(stream.sendMax).minus(stream.totalSent).minus(amountToSendFromStream)
      /* tslint:disable-next-line:no-unnecessary-type-assertion */
      if (amountLeftStreamWantsToSend.times(this.exchangeRate!).isGreaterThan(stream._remoteReceiveMax.minus(stream._remoteReceived))) {
        requestPacket.frames.push(new StreamMoneyBlockedFrame(stream.id, stream.sendMax, stream.totalSent))
      }

      if (maxAmountFromNextStream.isEqualTo(0)) {
        // TODO make sure that we start with those later frames the next time around
        break
      }
    }

    let bytesLeftInPacket = MAX_DATA_SIZE - requestPacket.byteLength()

    // Respect connection-level flow control
    const maxBytesRemoteConnectionCanReceive = this.remoteMaxOffset - this.getOutgoingOffsets().currentOffset
    if (bytesLeftInPacket > maxBytesRemoteConnectionCanReceive) {
      const outgoingMaxOffset = this.getOutgoingOffsets().maxOffset
      this.log.debug(`peer is blocking us from sending more data. they will only accept up to offset: ${this.remoteMaxOffset}, but we want to send up to: ${outgoingMaxOffset}`)
      requestPacket.frames.push(new ConnectionDataBlockedFrame(outgoingMaxOffset))
      bytesLeftInPacket = maxBytesRemoteConnectionCanReceive
    }

    for (let [_, stream] of this.streams) {
      // TODO use a sensible estimate for the StreamDataFrame overhead
      if (bytesLeftInPacket - 20 <= 0) {
        // Never pass a negative offset to _getAmountAvailableToSend.
        break
      }
      const { data, offset } = stream._getAvailableDataToSend(bytesLeftInPacket - 20)
      if (data && data.length > 0) {
        const streamDataFrame = new StreamDataFrame(stream.id, offset, data)
        this.log.trace(`sending ${data.length} bytes from stream ${stream.id}`)
        bytesLeftInPacket -= streamDataFrame.byteLength()
        requestPacket.frames.push(streamDataFrame)
      }

      // Inform remote which streams are blocked
      const maxOutgoingOffset = stream._isDataBlocked()
      if (maxOutgoingOffset) {
        this.log.trace(`telling remote that stream ${stream.id} is blocked and has more data to send`)
        requestPacket.frames.push(new StreamDataBlockedFrame(stream.id, maxOutgoingOffset))
      }
    }

    // Check if we can stop sending
    if (amountToSend.isEqualTo(0)) {
      if (requestPacket.frames.length === 0) {
        this.sending = false
        return
      } else {
        // Check if any Close, Data, or Money Frames are present in the packet.
        // If any of those are do not sent sending to false so the send loop
        // has an opportunity to retry if those packets are rejected.
        if (!requestPacket.frames.find(frame =>
            ((frame.type === FrameType.StreamClose)
            || (frame.type === FrameType.StreamData)
            || (frame.type === FrameType.StreamMoney)))) {
          this.sending = false
        }
      }
    }

    // Set minimum destination amount
    if (this.exchangeRate) {
      const minimumDestinationAmount = amountToSend.times(this.exchangeRate)
        .times(new BigNumber(1).minus(this.slippage))
        .integerValue(BigNumber.ROUND_FLOOR)
      if (minimumDestinationAmount.isGreaterThan(0)) {
        requestPacket.prepareAmount = minimumDestinationAmount
      }
    }

    const responsePacket = await this.sendPacket(requestPacket, amountToSend, false)

    if (responsePacket) {
      this.handleControlFrames(responsePacket.frames)

      // Track the exchange rate for the last packet (whether it was fulfilled or rejected)
      if (amountToSend.isGreaterThan(0)) {
        this._lastPacketExchangeRate = responsePacket.prepareAmount.dividedBy(amountToSend)
      }

      if (responsePacket.ilpPacketType === IlpPacketType.Fulfill) {
        for (let stream of streamsSentFrom) {
          stream._executeHold(requestPacket.sequence.toString())
        }

        // Update stats based on amount sent
        this._totalDelivered = this._totalDelivered.plus(responsePacket.prepareAmount)
        this._totalSent = this._totalSent.plus(amountToSend)

        // If we're trying to pinpoint the Maximum Packet Amount, raise
        // the limit because we know that the testMaximumPacketAmount works
        if (amountToSend.isEqualTo(this.testMaximumPacketAmount)
            && this.testMaximumPacketAmount.isLessThan(this.maximumPacketAmount)) {
          let newTestMax
          if (this.maximumPacketAmount.isFinite()) {
            // Take the max packet amount / 10 and then add it to the last test packet amount for an additive increase
            const additiveIncrease = this.maximumPacketAmount.dividedToIntegerBy(10)
            newTestMax = BigNumber.min(this.testMaximumPacketAmount.plus(additiveIncrease), this.maximumPacketAmount)
            this.log.trace(`last packet amount was successful (max packet amount: ${this.maximumPacketAmount}), raising packet amount from ${this.testMaximumPacketAmount} to: ${newTestMax}`)
          } else {
            // Increase by 2 times in this case since we do not know the max packet amount
            newTestMax = this.testMaximumPacketAmount.times(2)
            this.log.trace(`last packet amount was successful, unknown max packet amount, raising packet amount from: ${this.testMaximumPacketAmount} to: ${newTestMax}`)
          }
          this.testMaximumPacketAmount = newTestMax
        }

        // Reset the retry delay
        this.retryDelay = RETRY_DELAY_START
      }
    }
  }
  /**
   * (Internal) Send volly of test packests to find the exchange rate, its precision, and potential other amounts to try.
   * @private
   */
  protected async sendTestPacketVolley (testPacketAmounts: number[]): Promise<any> {
    const results = await Promise.all(testPacketAmounts.map(async (amount) => {
      try {
        return this.sendTestPacket(new BigNumber(amount))
      } catch (err) {
        this.log.error(`Error sending test packet for amount ${amount}:`, err)
        return null
      }
    }))

    // parse F08 packets and get the max packet amounts from them
    const maxPacketAmounts = testPacketAmounts.map((sourceAmount, index) => {
      if (results[index] && (results[index] as IlpPacket.IlpReject).code === 'F08') {
        try {
          const reader = Reader.from((results[index] as IlpPacket.IlpReject).data)
          const receivedAmount = reader.readUInt64BigNum()
          const maximumAmount = reader.readUInt64BigNum()
          const maximumPacketAmount = new BigNumber(sourceAmount)
            .times(maximumAmount)
            .dividedToIntegerBy(receivedAmount)
          this.log.debug(`sending test packet of ${testPacketAmounts[index]} resulted in F08 error that told us maximum packet amount is ${maximumPacketAmount}`)
          return maximumPacketAmount
        } catch (err) {
          return new BigNumber(Infinity)
        }
      }
      return new BigNumber(Infinity)
    })

    // Figure out which test packet discovered the exchange rate with the most precision and gather packet error codes
    const { maxDigits, exchangeRate, packetErrors } = results.reduce<any>(({ maxDigits, exchangeRate, packetErrors }, result, index) => {
      if (result && (result as IlpPacket.IlpReject).code) {
        packetErrors.push((result as IlpPacket.IlpReject).code)
      }
      if (result && (result as Packet).prepareAmount) {
        const prepareAmount = (result as Packet).prepareAmount
        const exchangeRate = prepareAmount.dividedBy(testPacketAmounts[index])
        this.log.debug(`sending test packet of ${testPacketAmounts[index]} delivered ${prepareAmount} (exchange rate: ${exchangeRate})`)
        if (prepareAmount.precision(true) >= maxDigits) {
          return {
            maxDigits: prepareAmount.precision(true),
            exchangeRate,
            packetErrors
          }
        }
      }
      return { maxDigits, exchangeRate, packetErrors }
    }, { maxDigits: 0, exchangeRate: new BigNumber(0), packetErrors: [] })
    return { maxDigits, exchangeRate, maxPacketAmounts, packetErrors }
  }

  /**
   * (Internal) Probe using test packets to find the exchange rate.
   * @private
   */
  protected async determineExchangeRate (): Promise<void> {
    this.log.trace('determineExchangeRate')
    if (!this._destinationAccount) {
      throw new Error('Cannot determine exchange rate. Destination account is unknown')
    }

    let retryDelay = RETRY_DELAY_START
    let testPacketAmounts = [1, 1000, 1000000, 1000000000, 1000000000000] // 1, 10^3, 10^6, 10^9, 10^12
    let attempts = 0

    // set a max attempts in case F08 & TXX errors keep occurring
    while (!this.exchangeRate && testPacketAmounts.length > 0 && attempts < 20) {
      attempts++
      const { maxDigits, exchangeRate, maxPacketAmounts, packetErrors } = await this.sendTestPacketVolley(testPacketAmounts)

      this.maximumPacketAmount = BigNumber.minimum(...maxPacketAmounts.concat(this.maximumPacketAmount))
      this.testMaximumPacketAmount = this.maximumPacketAmount
      if (this.maximumPacketAmount.isEqualTo(0)) {
        this.log.error(`cannot send anything through this path. the maximum packet amount is 0`)
        throw new Error('Cannot send. Path has a Maximum Packet Amount of 0')
      }

      if (maxDigits >= this.minExchangeRatePrecision) {
        this.log.debug(`determined exchange rate to be ${exchangeRate} with ${maxDigits} digits precision`)
        this.exchangeRate = exchangeRate
        return
      }

      // Find the smallest packet amount we tried in case we ran into Txx errors
      const smallestPacketAmount = testPacketAmounts.reduce((min: any, amount: any) => BigNumber.min(min, new BigNumber(amount)), new BigNumber(Infinity))
      // If we get here the first volley failed, try new volley using all unique packet amounts based on the max packets
      testPacketAmounts = maxPacketAmounts
        .filter((amount: any) => !amount.isEqualTo(new BigNumber(Infinity)))
        .reduce((acc: any, curr: any) => [...new Set([...acc, curr.toString()])], [])

      // Check for any Txx Errors
      if (packetErrors.some((code: string) => code[0] === 'T')) {
        const reducedPacketAmount = smallestPacketAmount.minus(smallestPacketAmount.dividedToIntegerBy(3))
        this.log.debug(`got Txx error(s), waiting ${retryDelay}ms and reducing packet amount to ${reducedPacketAmount} before sending another test packet`)
        testPacketAmounts = [...testPacketAmounts, reducedPacketAmount]
        await new Promise((resolve, reject) => setTimeout(resolve, retryDelay))
        retryDelay *= RETRY_DELAY_INCREASE_FACTOR
      }

      this.log.debug(`retry with packet amounts ${testPacketAmounts}`)
    }

    throw new Error(`Unable to establish connection, no packets meeting the minimum exchange precision of ${this.minExchangeRatePrecision} digits made it through the path.`)
  }

  /**
   * (Internal) Send an unfulfillable test packet. Primarily used for determining the path exchange rate.
   * @private
   */
  protected async sendTestPacket (amount: BigNumber, timeout = DEFAULT_PACKET_TIMEOUT): Promise<Packet | IlpPacket.IlpReject | null> {
    // Set packet number to correlate response with request
    const requestPacket = new Packet(this.nextPacketSequence++, IlpPacketType.Prepare)

    this.log.trace(`sending test packet ${requestPacket.sequence} for amount: ${amount}. timeout: ${timeout}`)

    if (!this.remoteKnowsOurAccount) {
      // TODO attach a token to the account?
      requestPacket.frames.push(new ConnectionNewAddressFrame(this._sourceAccount))
      requestPacket.frames.push(new ConnectionAssetDetailsFrame(this._sourceAssetCode, this._sourceAssetScale))
    }

    const prepare = {
      destination: this._destinationAccount!,
      amount: amount.toString(),
      data: requestPacket.serializeAndEncrypt(this.sharedSecret),
      executionCondition: cryptoHelper.generateRandomCondition(),
      expiresAt: new Date(Date.now() + timeout)
    }

    /* tslint:disable-next-line:no-unnecessary-type-assertion */
    const responseData = await (new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.log.error(`test packet ${requestPacket.sequence} timed out before we got a response`)
        resolve(null)
      }, timeout)
      const result = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(prepare))
      clearTimeout(timer)
      resolve(result)
    }) as Promise<Buffer | null>)

    if (!responseData) {
      return null
    }
    this.bumpIdle()

    const ilpReject = IlpPacket.deserializeIlpReject(responseData)

    // Return the receiver's response if there was one
    let responsePacket
    if (ilpReject.code === 'F99' && ilpReject.data.length > 0) {
      responsePacket = Packet.decryptAndDeserialize(this.sharedSecret, ilpReject.data)

      // Ensure the response corresponds to the request
      if (!responsePacket.sequence.isEqualTo(requestPacket.sequence)) {
        this.log.error(`response packet sequence does not match the request packet. expected sequence: ${requestPacket.sequence}, got response packet:`, JSON.stringify(responsePacket))
        throw new Error(`Response packet sequence does not correspond to the request. Actual: ${responsePacket.sequence}, expected: ${requestPacket.sequence}`)
      }
      if (responsePacket.ilpPacketType !== responseData[0]) {
        this.log.error(`response packet was on wrong ILP packet type. expected ILP packet type: ${responseData[0]}, got:`, JSON.stringify(responsePacket))
        throw new Error(`Response says it should be on an ILP packet of type: ${responsePacket.ilpPacketType} but it was carried on an ILP packet of type: ${responseData[0]}`)
      }
    } else {
      this.log.debug(`test packet ${requestPacket.sequence} was rejected with a ${ilpReject.code} triggered by ${ilpReject.triggeredBy} error${ilpReject.message ? ' with the message: "' + ilpReject.message + '"' : ''}`)
    }

    if (responsePacket) {
      this.remoteKnowsOurAccount = true
      this.handleControlFrames(responsePacket.frames)
      return responsePacket
    } else {
      return ilpReject
    }
  }

  /**
   * Send a ConnectionClose frame to the other side
   */
  protected async sendConnectionClose (err?: ConnectionError | Error): Promise<void> {
    if (this.remoteClosed) {
      this.log.debug('not sending connection error because remote is already closed')
      return
    }

    let errorCode: ErrorCode
    let errorMessage
    if (err && err instanceof ConnectionError) {
      errorCode = err.streamErrorCode
      errorMessage = err.message
    } else if (err) {
      errorCode = ErrorCode.InternalError
      errorMessage = err.message
    } else {
      errorCode = ErrorCode.NoError
      errorMessage = ''
    }

    const packet = new Packet(this.nextPacketSequence, IlpPacketType.Prepare, 0, [
      new ConnectionCloseFrame(errorCode, errorMessage)
    ])

    try {
      const prepare = {
        destination: this._destinationAccount!,
        amount: '0',
        data: packet.serializeAndEncrypt(this.sharedSecret),
        executionCondition: cryptoHelper.generateRandomCondition(),
        expiresAt: new Date(Date.now() + DEFAULT_PACKET_TIMEOUT)
      }
      await this.plugin.sendData(IlpPacket.serializeIlpPrepare(prepare))
    } catch (err) {
      this.log.error(`error while trying to inform peer that connection is closing, but closing anyway`, err)
    }
    this.remoteClosed = true
  }

  /**
   * Helper function used to send all ILP Prepare packets.
   * This automatically generates the condition and sets the packet expiry.
   * It also ensures that responses are valid and match the outgoing request.
   */
  protected async sendPacket (packet: Packet, sourceAmount: BigNumber, unfulfillable = false): Promise<Packet | void> {
    this.log.trace(`sending packet ${packet.sequence} with source amount: ${sourceAmount}: ${JSON.stringify(packet)})`)
    const data = packet.serializeAndEncrypt(this.sharedSecret, (this.enablePadding ? MAX_DATA_SIZE : undefined))

    let fulfillment: Buffer | undefined
    let executionCondition: Buffer
    if (unfulfillable) {
      fulfillment = undefined
      executionCondition = cryptoHelper.generateRandomCondition()
    } else {
      fulfillment = cryptoHelper.generateFulfillment(this.sharedSecret, data)
      executionCondition = cryptoHelper.hash(fulfillment)
    }
    const prepare = {
      destination: this._destinationAccount!,
      amount: (sourceAmount).toString(),
      data,
      executionCondition,
      expiresAt: new Date(Date.now() + DEFAULT_PACKET_TIMEOUT)
    }

    const responseData = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(prepare))
    this.bumpIdle()

    let response: IlpPacket.IlpFulfill | IlpPacket.IlpReject
    try {
      if (responseData[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
        response = IlpPacket.deserializeIlpFulfill(responseData)
      } else if (responseData[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
        response = IlpPacket.deserializeIlpReject(responseData)
      } else {
        throw new Error(`Invalid response packet type: ${responseData[0]}`)
      }
    } catch (err) {
      this.log.error(`got invalid response from sending packet ${packet.sequence}:`, err, responseData.toString('hex'))
      throw new Error(`Invalid response when sending packet ${packet.sequence}: ${err.message}`)
    }

    // Handle fulfillment
    if (fulfillment && isFulfill(response)) {
      if (!cryptoHelper.hash(response.fulfillment).equals(executionCondition)) {
        this.log.error(`got invalid fulfillment for packet ${packet.sequence}: ${response.fulfillment.toString('hex')}. expected: ${fulfillment.toString('hex')} for condition: ${executionCondition.toString('hex')}`)
        throw new Error(`Got invalid fulfillment for packet ${packet.sequence}. Actual: ${response.fulfillment.toString('hex')}, expected: ${fulfillment.toString('hex')}`)
      }
    } else {
      response = response as IlpPacket.IlpReject

      this.undoRejectedPacket(packet)

      if (response.code !== 'F99') {
        return this.handleConnectorError(response, sourceAmount)
      }
    }

    // TODO correctly handle fulfills that come back without data attached (this will be treated like a reject)
    if (response.data.length === 0) {
      return undefined
    }

    // Parse response data from receiver
    let responsePacket: Packet
    try {
      responsePacket = Packet.decryptAndDeserialize(this.sharedSecret, response.data)
    } catch (err) {
      this.log.error(`unable to decrypt and parse response data:`, err, response.data.toString('hex'))
      // TODO should we continue processing anyway? what if it was fulfilled?
      throw new Error('Unable to decrypt and parse response data: ' + err.message)
    }

    // Ensure the response corresponds to the request
    if (!responsePacket.sequence.isEqualTo(packet.sequence)) {
      this.log.error(`response packet sequence does not match the request packet. expected sequence: ${packet.sequence}, got response packet:`, JSON.stringify(responsePacket))
      throw new Error(`Response packet sequence does not correspond to the request. Actual: ${responsePacket.sequence}, expected: ${packet.sequence}`)
    }
    if (responsePacket.ilpPacketType !== responseData[0]) {
      this.log.error(`response packet was on wrong ILP packet type. expected ILP packet type: ${responseData[0]}, got:`, JSON.stringify(responsePacket))
      throw new Error(`Response says it should be on an ILP packet of type: ${responsePacket.ilpPacketType} but it was carried on an ILP packet of type: ${responseData[0]}`)
    }

    this.log.debug(`got response to packet: ${packet.sequence}: ${JSON.stringify(responsePacket)}`)

    return responsePacket
  }

  /**
   * Roll back the effects of an outgoing packet that was rejected
   * @private
   */
  protected undoRejectedPacket (requestPacket: Packet) {
    this.log.debug(`packet ${requestPacket.sequence} was rejected`)

    // TODO resend control frames
    for (let frame of requestPacket.frames) {
      switch (frame.type) {
        case FrameType.StreamMoney:
          this.streams.get(frame.streamId.toNumber())!._cancelHold(requestPacket.sequence.toString())
          break
        case FrameType.StreamData:
          this.streams.get(frame.streamId.toNumber())!._resendOutgoingData(frame.data, frame.offset.toNumber())
          break
        case FrameType.StreamClose:
          this.queuedFrames.push(frame)
          break
        default:
          continue
      }
    }
  }

  /**
   * (Internal) Handle final and temporary errors that were not generated by the receiver.
   * @private
   */
  protected async handleConnectorError (reject: IlpPacket.IlpReject, amountSent: BigNumber) {
    this.log.debug(`handling reject triggered by: ${reject.triggeredBy} error: ${reject.code} message: ${reject.message} data: ${reject.data}`)
    if (reject.code === 'F08') {
      let receivedAmount
      let maximumAmount
      try {
        const reader = Reader.from(reject.data)
        receivedAmount = reader.readUInt64BigNum()
        maximumAmount = reader.readUInt64BigNum()
      } catch (err) {
        receivedAmount = undefined
        maximumAmount = undefined
      }
      if (receivedAmount && maximumAmount && receivedAmount.isGreaterThan(maximumAmount)) {
        const newMaximum = amountSent
          .times(maximumAmount)
          .dividedToIntegerBy(receivedAmount)
        this.log.trace(`reducing maximum packet amount from ${this.maximumPacketAmount} to ${newMaximum}`)
        this.maximumPacketAmount = newMaximum
        this.testMaximumPacketAmount = newMaximum
      } else {
        // Connector didn't include amounts
        this.maximumPacketAmount = amountSent.minus(1)
        this.testMaximumPacketAmount = this.maximumPacketAmount.dividedToIntegerBy(2)
      }
      if (this.maximumPacketAmount.isEqualTo(0)) {
        this.log.error(`cannot send anything through this path. the maximum packet amount is 0`)
        throw new Error('Cannot send. Path has a Maximum Packet Amount of 0')
      }
    } else if (reject.code[0] === 'T') {
      if (reject.code === 'T04') {
        // TODO add more sophisticated logic for handling bandwidth-related connector errors
        // we should really be keeping track of the amount sent within a given window of time
        // and figuring out the max amount per window. this logic is just a stand in to fix
        // infinite retries when it runs into this type of error
        const minPacketAmount = BigNumber.minimum(amountSent, this.testMaximumPacketAmount)
        const newTestAmount = minPacketAmount.minus(minPacketAmount.dividedToIntegerBy(3))
        this.testMaximumPacketAmount = BigNumber.maximum(2, newTestAmount) // don't let it go to zero, set to 2 so that the other side gets at least 1 after the exchange rate is taken into account
        this.log.warn(`got T04: Insufficient Liquidity error. reducing the packet amount to ${this.testMaximumPacketAmount}`)
      }

      // TODO should we reduce the packet amount on other TXX errors too?
      this.log.warn(`got ${reject.code} temporary error. waiting ${this.retryDelay}ms before trying again`)
      const delay = this.retryDelay
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_DELAY_MAX)
      await new Promise((resolve, reject) => setTimeout(resolve, delay))
    } else {
      this.log.error(`unexpected error. code: ${reject.code}, message: ${reject.message}, data: ${reject.data.toString('hex')}`)
      throw new Error(`Unexpected error while sending packet. Code: ${reject.code}, message: ${reject.message}`)
    }
  }

  protected safeEmit (event: string, ...args: any[]) {
    try {
      args.unshift(event)
      this.emit.apply(this, args)
    } catch (err) {
      this.log.debug(`error in ${event} handler:`, err)
    }
  }

  protected getOutgoingOffsets (): { currentOffset: number, maxOffset: number } {
    let currentOffset = 0
    let maxOffset = 0

    for (let [_, stream] of this.streams) {
      const streamOffsets = stream._getOutgoingOffsets()
      currentOffset += streamOffsets.current
      maxOffset += streamOffsets.max
    }
    return {
      currentOffset,
      maxOffset
    }
  }

  protected getIncomingOffsets (): { current: number, max: number, maxAcceptable: number } {
    let totalMaxOffset = 0
    let totalReadOffset = 0
    let totalBufferedData = 0
    for (let [_, stream] of this.streams) {
      const { max, current } = stream._getIncomingOffsets()
      totalMaxOffset += max
      totalReadOffset += current
      totalBufferedData += stream.readableLength
    }

    return {
      current: totalReadOffset,
      max: totalMaxOffset,
      maxAcceptable: totalReadOffset - totalBufferedData + this.maxBufferedData
    }
  }

  protected removeStreamRecord (stream: DataAndMoneyStream) {
    this.log.debug(`removing record of stream ${stream.id}`)
    this.streams.delete(stream.id)
    this.closedStreams[stream.id] = true
    if (!stream._sentEnd) {
      stream._sentEnd = true
      const streamEndFrame = (stream._errorMessage
        ? new StreamCloseFrame(stream.id, ErrorCode.ApplicationError, stream._errorMessage)
        : new StreamCloseFrame(stream.id, ErrorCode.NoError, ''))
      this.queuedFrames.push(streamEndFrame)
    }
  }

  private startIdleTimer (): void {
    if (this.idleTimeout === 0) return
    const idle = Date.now() - this.lastActive.getTime()
    this.idleTimer = setTimeout(() => this.testIdle(), this.idleTimeout - idle)
    // browser timers don't support unref
    /* tslint:disable-next-line:strict-type-predicates */
    if (typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref()
    }
    this.log.trace(`(re)starting idle timeout for ${this.idleTimeout}ms from now`)
  }

  private testIdle (): void {
    const idle = Date.now() - this.lastActive.getTime()
    if (idle >= this.idleTimeout) {
      this.log.error('Connection timed out due to inactivity, destroying connection')
      /* tslint:disable-next-line:no-floating-promises */
      this.destroy(new Error('Connection timed out due to inactivity'))
    } else {
      this.startIdleTimer()
    }
  }

  private bumpIdle (): void { this.lastActive = new Date() }
}

function isFulfill (packet: IlpPacket.IlpFulfill | IlpPacket.IlpReject): packet is IlpPacket.IlpFulfill {
  return packet.hasOwnProperty('fulfillment')
}
