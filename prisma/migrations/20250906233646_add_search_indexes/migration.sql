-- CreateIndex
CREATE INDEX "idx_birth_date" ON "Burial"("birthDate");

-- CreateIndex
CREATE INDEX "idx_death_date" ON "Burial"("deathDate");

-- CreateIndex
CREATE INDEX "idx_location" ON "Burial"("locationText");
