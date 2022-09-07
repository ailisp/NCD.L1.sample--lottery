import {
  NearBindgen,
  NearContract,
  near,
  call,
  view,
  UnorderedSet,
  bytes,
  assert,
} from "near-sdk-js";
import { FeeStrategy, StrategyType } from "./fee-strategies";
import { Lottery } from "./lottery";
import { asNEAR, ONE_NEAR, XCC_GAS } from "./utils";

BigInt.prototype["toJSON"] = function () {
  return this.toString();
};

// The @NearBindgen decorator allows this code to compile to Base64.
@NearBindgen
export class Contract extends NearContract {
  private owner: string;
  private winner: string;
  private lastPlayed: string;
  private active: boolean = true;
  private pot: bigint = ONE_NEAR;
  private lottery: Lottery = new Lottery();
  private feeStrategy: FeeStrategy = new FeeStrategy();
  private players: UnorderedSet = new UnorderedSet("players");

  constructor({ owner }: { owner: string }) {
    super();
    this.owner = owner;
  }

  default(): Contract {
    return new Contract({ owner: "" });
  }

  @view
  get_owner(): string {
    return this.owner;
  }

  @view
  get_winner(): string {
    return this.winner;
  }

  @view
  get_pot(): string {
    return `${asNEAR(this.pot)} NEAR`;
  }

  @view
  get_fee(): string {
    return asNEAR(this.fee()) + " NEAR";
  }

  @view
  get_fee_strategy(): StrategyType {
    return FeeStrategy.from(this.feeStrategy).strategyType;
  }

  @view
  get_has_played({ player }: { player: string }): boolean {
    return this.players.contains(player);
  }

  @view
  get_last_played(): string {
    return this.lastPlayed;
  }

  @view
  get_active(): boolean {
    return this.active;
  }

  @view
  explain_fees(): string {
    return FeeStrategy.from(this.feeStrategy).explain();
  }

  @view
  explain_lottery(): string {
    return Lottery.from(this.lottery).explain();
  }

  // --------------------------------------------------------------------------
  // Public CHANGE methods
  // --------------------------------------------------------------------------

  /**
   * "Pay to play"
   *
   * First time is free to play and you may win!
   *
   * If you've already played once then any other play costs you a fee.
   * This fee is calculated as 1 NEAR X the square of the total number of unique players
   */
  @call
  play(): void {
    assert(
      this.active,
      `${this.winner} won ${this.pot}. Please reset the game.`
    );
    const signer = near.signerAccountId();
    const deposit = BigInt(Number(near.attachedDeposit()));

    // if you've played before then you have to pay extra
    if (this.players.contains(signer)) {
      const fee = this.fee();
      assert(deposit >= fee, this.generateFeeMessage(fee));
      this.increasePot();

      // if it's your first time then you may win for the price of gas
    } else {
      this.players.set(signer);
    }

    this.lastPlayed = signer;

    if (Lottery.from(this.lottery).play()) {
      this.winner = signer;
      near.log(`${this.winner} won ${this.get_pot()}!`);

      if (this.winner.length > 0) {
        const promise = near.promiseBatchCreate(this.winner);

        // transfer payout to winner
        near.promiseBatchActionTransfer(promise, this.pot);

        // receive confirmation of payout before setting game to inactive
        const then = near.promiseThen(
          promise,
          near.currentAccountId(),
          "on_payout_complete",
          bytes(JSON.stringify({})),
          0,
          XCC_GAS
        );

        near.promiseReturn(then);
      }
    } else {
      near.log(
        `${
          this.lastPlayed
        } did not win.  The pot is currently ${this.get_pot()}`
      );
    }
  }

  @call
  configure_lottery({ chance }: { chance: number }): boolean {
    this.assertSelf();

    const lottery = Lottery.from(this.lottery);
    lottery.configure(chance);

    this.lottery = lottery;
    return true;
  }

  @call
  configure_fee({ strategy }: { strategy: StrategyType }): boolean {
    this.assertSelf();
    this.feeStrategy = new FeeStrategy(strategy);
    return true;
  }

  @call
  reset(): void {
    this.assertSelf();
    this.players.clear();
    this.winner = "";
    this.lastPlayed = "";
    this.pot = ONE_NEAR;
    this.active = true;
  }

  // this method is only here for the promise callback,
  // it should never be called directly
  @call
  on_payout_complete(): void {
    this.assertSelf();
    this.active = false;
    near.log("game over.");
  }

  @view
  randomStr(): string {
    return near.randomSeed();
  }

  // --------------------------------------------------------------------------
  // Private methods
  // --------------------------------------------------------------------------

  private fee(): bigint {
    return FeeStrategy.from(this.feeStrategy).calculate(
      this.players.len(),
      ONE_NEAR
    );
  }

  private increasePot(): void {
    this.pot = BigInt(this.pot) + BigInt(Number(near.attachedDeposit()));
  }

  private generateFeeMessage(fee: bigint): string {
    return `There are ${this.players.len()} players. Playing more than once now costs ${asNEAR(
      fee
    )} NEAR`;
  }

  private assertSelf(): void {
    assert(
      near.predecessorAccountId() === near.currentAccountId(),
      "Only this contract may call this method"
    );
  }
}
