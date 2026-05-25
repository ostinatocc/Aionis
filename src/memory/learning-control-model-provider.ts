export type LearningControlReviewResolver<TPacket, TReview> = (args: {
  reviewPacket: TPacket;
  suppliedReviewResult: TReview | null;
}) => TReview | null | Promise<TReview | null>;

export type LearningControlReviewProvider<TPacket, TReview> = {
  resolveReviewResult: LearningControlReviewResolver<TPacket, TReview>;
};
