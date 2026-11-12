-- CreateTable
CREATE TABLE "SimBalance" (
    "wallet" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimBalance_pkey" PRIMARY KEY ("wallet")
);

-- CreateTable
CREATE TABLE "SimTransfer" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromWallet" TEXT,
    "toWallet" TEXT,
    "amount" BIGINT NOT NULL,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimTransfer_pkey" PRIMARY KEY ("id")
);
